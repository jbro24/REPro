const { enrichOpportunity } = require('./agents');

const REPORT_VERSION = 'report-v2';

function overallAssessment(score, gaps = []) {
  if (!score) return 'No deterministic fit score is available yet.';
  const required = gaps.filter((gap) => gap.priority === 'REQUIRED');
  if (!required.length) return `The current evidence supports every required requirement at a deterministic score of ${score.overallScore}/100. Review the preferred gaps and the original posting before deciding.`;
  return `The current deterministic score is ${score.overallScore}/100 with ${required.length} required gap${required.length === 1 ? '' : 's'}. Review the evidence and suggested work before deciding whether this opportunity is worth pursuing.`;
}

function reportSourceSnapshot({ database, userId, opportunity, requirements, matchRun, score, gapRun, application }) {
  return {
    reportVersion: REPORT_VERSION,
    opportunityContentHash: opportunity.contentHash,
    requirementsId: requirements?.id || null,
    requirementsContentHash: requirements?.contentHash || null,
    matchRunId: matchRun?.id || null,
    matchRequirementsId: matchRun?.jobRequirementsId || null,
    scoreId: score?.id || null,
    scoreMatchRunId: score?.matchRunId || null,
    gapRunId: gapRun?.id || null,
    gapMatchRunId: gapRun?.matchRunId || null,
    candidateContextHash: database.getCandidateContextFingerprintForUser(userId),
    applicationId: application?.id || null,
    applicationUpdatedAt: application?.updatedAt || null,
  };
}

function buildReport({ database, userId, opportunity, requirements, matchRun, score, gaps = [], companySignals, relevance, roadmap = [], application }) {
  const gapRun = matchRun && database ? database.getGapRunForMatchRunForUser(matchRun.id, userId) : null;
  const evidenceMatch = matchRun?.results || [];
  const deterministic = {
    requirements: requirements?.requirements || null,
    evidenceMatch,
    fitScore: score ? {
      overall: score.overallScore,
      required: score.requiredScore,
      preferred: score.preferredScore,
      explanation: score.formula,
      formulaVersion: score.formulaVersion,
    } : null,
    gaps,
    roadmap,
    application: application || null,
  };
  return {
    reportVersion: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    opportunity: {
      role: opportunity.title,
      company: opportunity.company,
      location: opportunity.location,
      source: opportunity.sourceType,
      url: opportunity.url,
      discoveredAt: opportunity.discoveredAt,
      analysisState: opportunity.analysisState,
      analyzedAt: opportunity.analyzedAt,
    },
    requirements: deterministic.requirements,
    evidenceMatch,
    matchResults: evidenceMatch,
    fitScore: deterministic.fitScore,
    gaps,
    roadmap,
    suggestedEvidenceWork: roadmap,
    application: application || null,
    companySignals,
    relevantProjects: relevance?.projects || [],
    overallAssessment: overallAssessment(score, gaps),
    provenance: opportunity.provenance,
    deterministic,
    sourceSnapshot: database ? reportSourceSnapshot({ database, userId, opportunity, requirements, matchRun, score, gapRun, application }) : null,
  };
}

function uniqueReasons(reasons) {
  return [...new Set(reasons.filter(Boolean))];
}

function getReportFreshness({ database, userId, opportunity, reportRecord }) {
  if (!reportRecord) return { isStale: true, reasons: ['REPORT_NOT_AVAILABLE'], checkedAt: new Date().toISOString() };
  const report = reportRecord.report || reportRecord;
  const snapshot = report.sourceSnapshot;
  const reasons = [];
  if (!snapshot || snapshot.reportVersion !== REPORT_VERSION) reasons.push('REPORT_SOURCE_VERSION_UNAVAILABLE');
  if (snapshot?.opportunityContentHash !== opportunity.contentHash) reasons.push('OPPORTUNITY_CHANGED');

  const requirements = database.getLatestJobRequirementsForUser(opportunity.id, userId, opportunity.contentHash);
  if (!requirements) reasons.push('REQUIREMENTS_NOT_CURRENT');
  else if (snapshot?.requirementsId !== requirements.id || snapshot?.requirementsContentHash !== requirements.contentHash) reasons.push('REQUIREMENTS_CHANGED');

  const matchRun = database.getLatestMatchRunForUser(opportunity.id, userId);
  if (!matchRun || !requirements || matchRun.jobRequirementsId !== requirements.id) reasons.push('EVIDENCE_MATCH_NOT_CURRENT');
  else if (snapshot?.matchRunId !== matchRun.id || snapshot?.matchRequirementsId !== requirements.id) reasons.push('EVIDENCE_MATCH_CHANGED');

  const score = database.getLatestScoreForUser(opportunity.id, userId);
  if (!score || !matchRun || score.matchRunId !== matchRun.id) reasons.push('SCORE_NOT_CURRENT');
  else if (snapshot?.scoreId !== score.id || snapshot?.scoreMatchRunId !== matchRun.id) reasons.push('SCORE_CHANGED');

  const gapRun = matchRun ? database.getGapRunForMatchRunForUser(matchRun.id, userId) : null;
  if (!gapRun || !score || gapRun.matchRunId !== score.matchRunId) reasons.push('GAPS_NOT_CURRENT');
  else if (snapshot?.gapRunId !== gapRun.id || snapshot?.gapMatchRunId !== matchRun.id) reasons.push('GAPS_CHANGED');

  if (snapshot?.candidateContextHash !== database.getCandidateContextFingerprintForUser(userId)) reasons.push('CANDIDATE_CONTEXT_CHANGED');
  if (opportunity.analysisState === 'STALE') reasons.push('OPPORTUNITY_MARKED_STALE');

  return {
    isStale: reasons.length > 0,
    reasons: uniqueReasons(reasons),
    checkedAt: new Date().toISOString(),
    lastAnalyzedAt: opportunity.analyzedAt || reportRecord.updatedAt || null,
  };
}

async function buildAndSaveReport({ database, userId, opportunity, requirements, matchRun, score, gaps, projects, agents }) {
  const enrichment = await enrichOpportunity({ agents, opportunity, requirements: requirements.requirements, gaps, projects });
  const companySignals = database.saveCompanySignalsForUser(userId, opportunity.id, enrichment.companySignals);
  const relevance = database.saveProjectRelevanceForUser(userId, opportunity.id, enrichment.relevance);
  const roadmap = database.replaceRoadmapItemsForUser(userId, opportunity.id, enrichment.roadmap);
  const application = database.getApplicationForOpportunityForUser(opportunity.id, userId);
  const report = buildReport({ database, userId, opportunity, requirements, matchRun, score, gaps, companySignals, relevance, roadmap, application });
  let provider = 'deterministic-report';
  if (agents.reportSynthesis) {
    try {
      const synthesisFacts = JSON.parse(JSON.stringify({
        opportunity: report.opportunity,
        requirements: report.requirements,
        evidenceMatch: report.evidenceMatch,
        fitScore: report.fitScore,
        gaps: report.gaps,
        roadmap: report.roadmap,
        companySignals: report.companySignals,
        relevantProjects: report.relevantProjects,
      }));
      const output = typeof agents.reportSynthesis === 'function'
        ? await agents.reportSynthesis({ facts: synthesisFacts })
        : await agents.reportSynthesis.report({ facts: synthesisFacts });
      if (typeof output?.summary === 'string' && output.summary.trim()) report.synthesizedSummary = output.summary.trim().slice(0, 4000);
      provider = output?.provider || agents.reportSynthesis.name || 'configured-provider';
      report.synthesis = { status: report.synthesizedSummary ? 'READY' : 'UNAVAILABLE', provider };
    } catch {
      report.synthesisNote = 'The readable report summary provider was unavailable; deterministic facts remain available.';
      report.synthesis = { status: 'FAILED', provider: agents.reportSynthesis.name || '' };
    }
  } else {
    report.synthesis = { status: 'UNCONFIGURED', provider: '' };
  }
  const saved = database.saveOpportunityReportForUser(userId, opportunity.id, { status: 'READY', provider, report });
  return { companySignals, relevance, roadmap, report: saved };
}

module.exports = { REPORT_VERSION, buildAndSaveReport, buildReport, getReportFreshness, overallAssessment, reportSourceSnapshot };
