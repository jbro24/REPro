const APPLICATION_STATUSES = Object.freeze(['DRAFT', 'IN_REVIEW', 'READY_FOR_REVIEW', 'ARCHIVED']);
const CLAIM_VERDICTS = Object.freeze(['SUPPORTED', 'UNSUPPORTED', 'NEEDS_REVIEW']);

function tokens(value) {
  return new Set(String(value || '').toLowerCase().split(/[^a-z0-9+#.]+/).filter((token) => token.length > 1));
}

function phraseIn(text, value) {
  return String(text || '').toLowerCase().includes(String(value || '').toLowerCase());
}

function linkedEvidenceFor({ evidence = [], skill, project }) {
  return evidence.filter((item) => (skill && (item.links || []).some((link) => link.entityType === 'skill' && link.entityId === skill.id)) || (project && (item.links || []).some((link) => link.entityType === 'project' && link.entityId === project.id)));
}

function applicationSourceSnapshot(context = {}) {
  return {
    version: 'application-source-v1',
    opportunityContentHash: context.opportunity?.contentHash || '',
    requirementsId: context.requirements?.id || '',
    requirementsContentHash: context.requirements?.contentHash || '',
    matchRunId: context.matchRun?.id || '',
    scoreId: context.score?.id || '',
    gapRunId: context.gapRun?.id || '',
    gapIds: (context.gaps || []).map((gap) => gap.id).sort(),
    candidateContextFingerprint: context.candidateContextFingerprint || '',
  };
}

function applicationFreshness(application, context) {
  if (!application) return { isStale: true, reasons: ['MISSING_APPLICATION'] };
  const current = applicationSourceSnapshot(context);
  const saved = application.sourceSnapshot || {};
  const reasons = Object.keys(current).filter((key) => JSON.stringify(saved[key] ?? '') !== JSON.stringify(current[key] ?? '')).map((key) => key);
  if (!context.requirements || !context.matchRun || !context.score || !context.gaps) reasons.push('ANALYSIS_NOT_CURRENT');
  if (application.stale && application.staleReason) reasons.push(application.staleReason);
  return { isStale: reasons.length > 0, reasons: [...new Set(reasons)], currentSnapshot: current };
}

function claimSupport(sentence, context) {
  const text = String(sentence || '').trim();
  const lower = text.toLowerCase();
  if (!text) return null;
  if (/\b(i am interested|i would welcome|i am applying)\b/i.test(text)) return { verdict: 'SUPPORTED', reason: 'The sentence describes the candidate’s stated interest in this opportunity.', evidence: [] };

  const matchedSkills = context.skills.filter((skill) => phraseIn(text, skill.name));
  const matchedProjects = context.projects.filter((project) => phraseIn(text, project.name));
  const matchedGaps = (context.gaps || []).filter((gap) => phraseIn(text, gap.requirementText));
  const supporting = [];
  for (const skill of matchedSkills) supporting.push(...linkedEvidenceFor({ evidence: context.evidence, skill }));
  for (const project of matchedProjects) supporting.push(...linkedEvidenceFor({ evidence: context.evidence, project }));
  const uniqueEvidence = [...new Map(supporting.map((item) => [item.id, item])).values()];

  const overclaim = /\b(professional|production|expert|years? of|certified|managed|led)\b/i.test(text);
  const learningSkill = matchedSkills.find((skill) => skill.status === 'LEARNING');
  if (matchedGaps.length && overclaim && !matchedSkills.some((skill) => skill.status === 'VERIFIED')) return { verdict: 'UNSUPPORTED', reason: 'The sentence makes a stronger claim than the persisted deterministic gap and available evidence support.', evidence: uniqueEvidence };
  if (learningSkill && overclaim) return { verdict: 'UNSUPPORTED', reason: `${learningSkill.name} is recorded as LEARNING, so this wording overstates the current evidence state.`, evidence: uniqueEvidence };
  if (matchedSkills.some((skill) => skill.status === 'NO_EVIDENCE')) return { verdict: 'UNSUPPORTED', reason: 'The referenced skill has NO_EVIDENCE in the candidate profile.', evidence: uniqueEvidence };
  if (matchedSkills.length && matchedSkills.every((skill) => skill.status === 'VERIFIED')) return { verdict: uniqueEvidence.length ? 'SUPPORTED' : 'NEEDS_REVIEW', reason: uniqueEvidence.length ? 'The referenced skills are VERIFIED and linked to explicit evidence.' : 'The referenced skills are marked VERIFIED, but this claim has no linked supporting evidence.', evidence: uniqueEvidence };
  if (learningSkill && /\b(learning|developing|building|current|hands-on project)\b/i.test(text)) return { verdict: uniqueEvidence.length ? 'SUPPORTED' : 'NEEDS_REVIEW', reason: uniqueEvidence.length ? 'The learning wording is consistent with the profile and linked evidence.' : 'The wording is honest for a learning state, but linked evidence should be reviewed.', evidence: uniqueEvidence };
  if (matchedProjects.length) return { verdict: uniqueEvidence.length ? 'SUPPORTED' : 'NEEDS_REVIEW', reason: uniqueEvidence.length ? 'The project is explicitly linked to supporting evidence.' : 'The project exists in the profile, but no linked evidence was found.', evidence: uniqueEvidence };

  const sentenceTokens = tokens(text);
  const profileTokens = tokens([context.profile?.summary, context.profile?.current_status, context.profile?.location].join(' '));
  if ([...sentenceTokens].some((token) => profileTokens.has(token))) return { verdict: 'NEEDS_REVIEW', reason: 'The sentence overlaps profile context but needs a human evidence check.', evidence: [] };
  return { verdict: 'NEEDS_REVIEW', reason: 'No matching profile or evidence record was found for this factual sentence.', evidence: [] };
}

function splitClaims(draftText) {
  return String(draftText || '').replace(/\r/g, '').split(/(?<=[.!?])\s+|\n+/).map((item) => item.trim()).filter(Boolean);
}

function groundClaims(draftText, context) {
  return splitClaims(draftText).map((claimText, index) => {
    const support = claimSupport(claimText, context);
    return { claimText, claimOrder: index, verdict: support.verdict, reason: support.reason, evidence: support.evidence.map((item) => ({ id: item.id, title: item.title, status: item.status })) };
  });
}

function buildApplicationDraft({ opportunity, profile, skills = [], projects = [], evidence = [], gaps = [] }) {
  const verified = skills.filter((skill) => skill.status === 'VERIFIED').map((skill) => skill.name);
  const learning = skills.filter((skill) => skill.status === 'LEARNING').map((skill) => skill.name);
  const lines = [`I am interested in the ${opportunity.title} opportunity at ${opportunity.company}.`];
  if (profile?.summary) lines.push(profile.summary.trim());
  if (verified.length) lines.push(`My profile includes verified work with ${verified.join(', ')}.`);
  if (projects.length) lines.push(`Relevant project work includes ${projects.slice(0, 3).map((project) => project.name).join(', ')}.`);
  if (learning.length) lines.push(`I am currently developing ${learning.join(', ')} through ongoing project work; I do not present these as verified production experience.`);
  if (gaps.length) lines.push(`The current analysis identifies ${gaps.map((gap) => gap.requirementText).join(', ')} as evidence gaps, which I would address through the suggested evidence-building work.`);
  else lines.push('The current deterministic analysis identifies no requirement gaps in the available evidence.');
  return lines.join('\n\n');
}

function summarizeClaims(claims = []) {
  return { supported: claims.filter((claim) => claim.verdict === 'SUPPORTED').length, unsupported: claims.filter((claim) => claim.verdict === 'UNSUPPORTED').length, needsReview: claims.filter((claim) => claim.verdict === 'NEEDS_REVIEW').length };
}

module.exports = { APPLICATION_STATUSES, CLAIM_VERDICTS, applicationFreshness, applicationSourceSnapshot, buildApplicationDraft, groundClaims, splitClaims, summarizeClaims };
