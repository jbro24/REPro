const { normalizeText } = require('./opportunity');

const MATCHER_VERSION = 'matcher-v1';
const MATCH_STATES = Object.freeze(['MATCH', 'PARTIAL', 'MISSING']);

function evidenceSummary(item) {
  return { id: item.id, title: item.title, status: item.status_context, evidenceType: item.evidence_type, sourceType: item.source_type };
}

function linkedEvidenceForSkill(skillId, evidence) {
  return evidence.filter((item) => item.links.some((link) => link.entityType === 'skill' && link.entityId === skillId));
}

function matchSkillRequirement(requirement, priority, skills, evidence) {
  const normalized = normalizeText(requirement.name || requirement.text);
  const candidates = skills.filter((skill) => normalizeText(skill.name) === normalized);
  if (!candidates.length) {
    return { requirementId: requirement.id, requirementType: 'SKILL', priority, requirementText: requirement.name || requirement.text, matchState: 'MISSING', evidence: [], reason: 'No matching candidate skill declaration exists.' };
  }
  const linked = candidates.flatMap((skill) => linkedEvidenceForSkill(skill.id, evidence));
  const uniqueEvidence = [...new Map(linked.map((item) => [item.id, item])).values()];
  const summaries = uniqueEvidence.map(evidenceSummary);
  const hasVerifiedCapability = candidates.some((skill) => skill.status === 'VERIFIED') && uniqueEvidence.some((item) => item.status_context === 'VERIFIED');
  if (hasVerifiedCapability) return { requirementId: requirement.id, requirementType: 'SKILL', priority, requirementText: requirement.name || requirement.text, matchState: 'MATCH', evidence: summaries, reason: 'A VERIFIED skill state is supported by explicitly linked VERIFIED evidence.' };
  const hasLearning = candidates.some((skill) => skill.status === 'LEARNING') || uniqueEvidence.some((item) => item.status_context === 'LEARNING');
  if (hasLearning) return { requirementId: requirement.id, requirementType: 'SKILL', priority, requirementText: requirement.name || requirement.text, matchState: 'PARTIAL', evidence: summaries, reason: 'The skill is marked LEARNING or has learning evidence, but no VERIFIED evidence supports the requirement.' };
  if (!uniqueEvidence.length) return { requirementId: requirement.id, requirementType: 'SKILL', priority, requirementText: requirement.name || requirement.text, matchState: 'MISSING', evidence: [], reason: 'A matching skill declaration exists, but no explicitly linked structured evidence supports it.' };
  return { requirementId: requirement.id, requirementType: 'SKILL', priority, requirementText: requirement.name || requirement.text, matchState: 'MISSING', evidence: summaries, reason: 'Linked evidence exists, but it does not establish a VERIFIED capability state.' };
}

function unsupportedRequirement(requirement, priority, type) {
  return { requirementId: requirement.id, requirementType: type, priority, requirementText: requirement.text, matchState: 'MISSING', evidence: [], reason: 'No deterministic evidence rule currently maps this requirement category to candidate evidence.' };
}

function flattenRequirements(requirements) {
  const result = [];
  for (const item of requirements.requiredSkills || []) result.push({ item, priority: 'REQUIRED', type: 'SKILL' });
  for (const item of requirements.preferredSkills || []) result.push({ item, priority: 'PREFERRED', type: 'SKILL' });
  for (const item of requirements.experienceRequirements || []) result.push({ item, priority: 'REQUIRED', type: 'EXPERIENCE' });
  for (const item of requirements.educationRequirements || []) result.push({ item, priority: 'REQUIRED', type: 'EDUCATION' });
  for (const item of requirements.locationRequirements || []) result.push({ item, priority: 'REQUIRED', type: 'LOCATION' });
  for (const item of requirements.otherConstraints || []) result.push({ item, priority: 'REQUIRED', type: 'OTHER' });
  return result;
}

function matchRequirements({ requirements, skills, evidence }) {
  const results = flattenRequirements(requirements).map(({ item, priority, type }) => type === 'SKILL'
    ? matchSkillRequirement(item, priority, skills, evidence)
    : unsupportedRequirement(item, priority, type));
  return { matcherVersion: MATCHER_VERSION, results };
}

module.exports = { MATCHER_VERSION, MATCH_STATES, flattenRequirements, matchRequirements };
