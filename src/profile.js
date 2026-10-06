const CURRENT_STATUSES = Object.freeze(['employed', 'seeking', 'student', 'career_break', 'freelance', 'other']);
const SKILL_STATUSES = Object.freeze(['VERIFIED', 'LEARNING', 'NO_EVIDENCE']);
const ONBOARDING_STEPS = Object.freeze(['welcome', 'profile', 'skills', 'projects', 'experience', 'evidence', 'complete']);

function text(value, maxLength, { required = false, field = 'Value' } = {}) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (required && !result) return `${field} is required.`;
  if (result.length > maxLength) return `${field} must be ${maxLength} characters or fewer.`;
  return null;
}

function list(value, maxItems = 30, maxItemLength = 100) {
  let values = value;
  if (typeof values === 'string') values = values.split(/[\n,]/);
  if (!Array.isArray(values)) values = [];
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))].slice(0, maxItems).map((item) => item.slice(0, maxItemLength));
}

function listError(value, field, maxItems = 30) {
  if (Array.isArray(value) && value.length > maxItems) return `${field} cannot contain more than ${maxItems} items.`;
  return null;
}

function validDate(value) {
  if (!value) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateDateRange(startDate, endDate) {
  if (!validDate(startDate) || !validDate(endDate)) return 'Dates must use YYYY-MM-DD format.';
  if (startDate && endDate && startDate > endDate) return 'End date cannot be before start date.';
  return null;
}

function validateUrl(value, field = 'URL') {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 2048) return `${field} must be 2048 characters or fewer.`;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return `${field} must be a public HTTP or HTTPS URL.`;
  } catch {
    return `${field} must be a valid HTTP or HTTPS URL.`;
  }
  return null;
}

function parseJsonList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function validateProfile(input) {
  const targetRoles = list(input.targetRoles, 10, 120);
  const errors = [
    text(input.name, 120, { required: true, field: 'Name' }),
    text(input.location, 160, { field: 'Location' }),
    text(input.summary, 1200, { field: 'Professional summary' }),
    listError(input.targetRoles, 'Target roles', 10),
  ].filter(Boolean);
  if (input.currentStatus && !CURRENT_STATUSES.includes(input.currentStatus)) errors.push('Choose a valid current status.');
  return { errors, value: { name: String(input.name || '').trim(), targetRoles, location: String(input.location || '').trim(), currentStatus: input.currentStatus || '', summary: String(input.summary || '').trim() } };
}

function validateEducation(input) {
  const startDate = String(input.startDate || '').trim();
  const endDate = String(input.endDate || '').trim();
  const errors = [
    text(input.institution, 180, { required: true, field: 'Institution' }),
    text(input.program, 180, { required: true, field: 'Degree or program' }),
    text(input.field, 180, { field: 'Field' }),
    text(input.description, 1000, { field: 'Description' }),
    validateDateRange(startDate, endDate),
  ].filter(Boolean);
  return { errors, value: { institution: String(input.institution || '').trim(), program: String(input.program || '').trim(), field: String(input.field || '').trim(), startDate, endDate, description: String(input.description || '').trim() } };
}

function validateSkill(input) {
  const status = String(input.status || 'NO_EVIDENCE').trim();
  const supportingReference = String(input.supportingReference || '').trim();
  const errors = [
    text(input.name, 120, { required: true, field: 'Skill name' }),
    text(supportingReference, 1000, { field: 'Supporting evidence/reference' }),
    text(input.description, 500, { field: 'Description' }),
  ].filter(Boolean);
  if (!SKILL_STATUSES.includes(status)) errors.push('Choose VERIFIED, LEARNING, or NO_EVIDENCE.');
  if (status === 'VERIFIED' && !supportingReference) errors.push('A VERIFIED skill requires a supporting evidence/reference note.');
  return { errors, value: { name: String(input.name || '').trim(), status, supportingReference, description: String(input.description || '').trim() } };
}

function validateProject(input) {
  const timeframeStart = String(input.timeframeStart || '').trim();
  const timeframeEnd = String(input.timeframeEnd || '').trim();
  const errors = [
    text(input.name, 180, { required: true, field: 'Project name' }),
    text(input.description, 1600, { required: true, field: 'Project description' }),
    text(input.roleContribution, 1000, { field: 'Role or contribution' }),
    text(input.outcome, 1000, { field: 'Outcome' }),
    text(input.associatedEvidence, 1000, { field: 'Associated evidence/reference' }),
    listError(input.technologies, 'Technologies', 30),
    validateDateRange(timeframeStart, timeframeEnd),
    validateUrl(input.repositoryUrl, 'Repository URL'),
    validateUrl(input.demoUrl, 'Demo URL'),
  ].filter(Boolean);
  return { errors, value: { name: String(input.name || '').trim(), description: String(input.description || '').trim(), technologies: list(input.technologies), roleContribution: String(input.roleContribution || '').trim(), timeframeStart, timeframeEnd, repositoryUrl: String(input.repositoryUrl || '').trim(), demoUrl: String(input.demoUrl || '').trim(), outcome: String(input.outcome || '').trim(), associatedEvidence: String(input.associatedEvidence || '').trim() } };
}

function validateExperience(input) {
  const startDate = String(input.startDate || '').trim();
  const endDate = String(input.endDate || '').trim();
  const responsibilities = list(input.responsibilities);
  const technologies = list(input.technologies);
  const errors = [
    text(input.organization, 180, { required: true, field: 'Organization' }),
    text(input.role, 180, { required: true, field: 'Role' }),
    text(input.description, 1600, { field: 'Description' }),
    text(input.evidenceReference, 1000, { field: 'Evidence/reference' }),
    listError(input.responsibilities, 'Responsibilities'),
    listError(input.technologies, 'Technologies'),
    validateDateRange(startDate, endDate),
  ].filter(Boolean);
  return { errors, value: { organization: String(input.organization || '').trim(), role: String(input.role || '').trim(), description: String(input.description || '').trim(), startDate, endDate, responsibilities, technologies, evidenceReference: String(input.evidenceReference || '').trim() } };
}

function completionState(profile) {
  if (profile.onboarding_completed) return 'completed';
  if (profile.name || profile.target_roles_json !== '[]' || profile.summary) return 'in_progress';
  return 'not_started';
}

module.exports = {
  CURRENT_STATUSES,
  ONBOARDING_STEPS,
  SKILL_STATUSES,
  completionState,
  parseJsonList,
  validateEducation,
  validateExperience,
  validateProfile,
  validateProject,
  validateSkill,
  validateDateRange,
  validateUrl,
};
