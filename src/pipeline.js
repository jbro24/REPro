const { matchRequirements } = require('./matcher');
const { scoreMatchResults } = require('./scoring');
const { analyzeGaps } = require('./gaps');
const { AnalystOutputError, AnalystProviderError, ANALYST_VERSION, JOB_REQUIREMENTS_VERSION } = require('./jobAnalyst');

async function runAutomaticAnalysis({ database, userId, opportunityId, jobAnalyst, enrich }) {
  const opportunity = database.getOpportunityByIdForUser(opportunityId, userId);
  if (!opportunity) return { ok: false, stage: 'OPPORTUNITY', errorMessage: 'Resource not found.' };
  const contentHash = opportunity.contentHash || opportunity.content_hash;
  const rawContent = opportunity.rawContent || opportunity.raw_content;
  let requirements = database.getLatestJobRequirementsForUser(opportunityId, userId, contentHash);
  let matchRun = null;
  let score = null;
  let gaps = null;
  try {
    if (!requirements) {
      database.updateOpportunityAnalysisForUser(opportunityId, userId, 'ANALYZING');
      const analysis = await jobAnalyst.analyze(rawContent);
      requirements = database.createJobRequirementsForUser(userId, {
        opportunityId,
        contentHash,
        requirements: analysis.requirements,
        rawOutput: analysis.rawOutput,
        provider: analysis.provider,
        model: analysis.model,
        analystVersion: analysis.analysisVersion,
      });
      database.setOpportunityLifecycleStatusForUser(opportunityId, userId, 'ANALYZED');
    }
  } catch (error) {
    const message = error instanceof AnalystOutputError ? `The analyst output was not valid: ${error.message}` : error instanceof AnalystProviderError ? error.message : 'The job analysis could not be completed.';
    database.createFailedJobRequirementsForUser(userId, { opportunityId, contentHash, requirementsVersion: JOB_REQUIREMENTS_VERSION, analystVersion: ANALYST_VERSION, errorMessage: message });
    database.updateOpportunityAnalysisForUser(opportunityId, userId, 'FAILED_ANALYST', message);
    return { ok: false, stage: 'ANALYZE', errorMessage: message };
  }
  try {
    const result = matchRequirements({ requirements: requirements.requirements, skills: database.listSkillsForUser(userId), evidence: database.listEvidenceForUser(userId) });
    matchRun = database.createMatchRunForUser(userId, { opportunityId, jobRequirementsId: requirements.id, matcherVersion: result.matcherVersion, results: result.results });
    database.updateOpportunityAnalysisForUser(opportunityId, userId, 'MATCHED');
  } catch {
    const message = 'Evidence matching could not be completed.';
    database.updateOpportunityAnalysisForUser(opportunityId, userId, 'FAILED_MATCH', message);
    return { ok: false, stage: 'MATCH', requirements, errorMessage: message };
  }
  try {
    score = database.createScoreBreakdownForUser(userId, { opportunityId, matchRunId: matchRun.id, jobRequirementsId: requirements.id, formulaVersion: require('./scoring').SCORE_FORMULA_VERSION, score: scoreMatchResults(matchRun.results) });
    database.updateOpportunityAnalysisForUser(opportunityId, userId, 'SCORED');
  } catch {
    const message = 'Deterministic scoring could not be completed.';
    database.updateOpportunityAnalysisForUser(opportunityId, userId, 'FAILED_SCORE', message);
    return { ok: false, stage: 'SCORE', requirements, matchRun, errorMessage: message };
  }
  try {
    const result = analyzeGaps({ matchResults: matchRun.results });
    const saved = database.createGapsForUser(userId, { opportunityId, matchRunId: matchRun.id, logicVersion: result.logicVersion, gaps: result.gaps });
    gaps = saved.gaps;
    database.updateOpportunityAnalysisForUser(opportunityId, userId, 'COMPLETE');
  } catch {
    const message = 'Gap analysis could not be completed.';
    database.updateOpportunityAnalysisForUser(opportunityId, userId, 'FAILED_GAPS', message);
    return { ok: false, stage: 'GAPS', requirements, matchRun, score, errorMessage: message };
  }
  if (enrich) {
    try {
      const currentOpportunity = database.getOpportunityByIdForUser(opportunityId, userId) || opportunity;
      await enrich({ opportunity: currentOpportunity, requirements, matchRun, score, gaps });
    } catch {
      const message = 'The opportunity report could not be assembled.';
      database.saveOpportunityReportForUser(userId, opportunityId, { status: 'FAILED', provider: '', report: {}, errorMessage: message });
      database.updateOpportunityAnalysisForUser(opportunityId, userId, 'FAILED_REPORT', message);
      return { ok: false, stage: 'REPORT', opportunity: database.getOpportunityByIdForUser(opportunityId, userId), requirements, matchRun, score, gaps, errorMessage: message };
    }
  }
  return { ok: true, opportunity: database.getOpportunityByIdForUser(opportunityId, userId), requirements, matchRun, score, gaps };
}

module.exports = { runAutomaticAnalysis };
