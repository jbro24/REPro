const { validateDateRange, validateUrl } = require('./profile');

const EVIDENCE_TYPES = Object.freeze(['PROJECT', 'REPOSITORY', 'DEPLOYMENT', 'WORK_EXPERIENCE', 'CERTIFICATION', 'EDUCATION', 'DOCUMENT', 'PUBLICATION', 'PATENT', 'OTHER']);
const EVIDENCE_STATUSES = Object.freeze(['VERIFIED', 'LEARNING', 'NO_EVIDENCE']);
const SOURCE_TYPES = Object.freeze(['USER_PROVIDED_REFERENCE', 'REPOSITORY', 'DOCUMENT', 'PUBLICATION', 'OTHER']);
const LINK_TYPES = Object.freeze(['skill', 'project', 'experience', 'education']);

function cleanList(value, maxItems = 30) {
  let values = value;
  if (typeof values === 'string') values = values.split(/[\n,]/);
  if (!Array.isArray(values)) values = [];
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))].slice(0, maxItems);
}

function text(value, maxLength, { required = false, field = 'Value' } = {}) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (required && !result) return `${field} is required.`;
  if (result.length > maxLength) return `${field} must be ${maxLength} characters or fewer.`;
  return null;
}

function validateEvidence(input) {
  input = input && typeof input === 'object' ? input : {};
  const timeframeStart = String(input.timeframeStart || '').trim();
  const timeframeEnd = String(input.timeframeEnd || '').trim();
  const evidenceType = String(input.evidenceType || '').trim();
  const status = String(input.status || 'NO_EVIDENCE').trim();
  const sourceType = String(input.sourceType || 'USER_PROVIDED_REFERENCE').trim();
  const errors = [
    text(input.title, 180, { required: true, field: 'Title' }),
    text(input.description, 3000, { required: true, field: 'Description' }),
    text(input.sourceTitle, 240, { field: 'Source title' }),
    text(input.sourceReference, 1600, { required: true, field: 'Source/reference' }),
    text(input.notes, 1600, { field: 'Notes' }),
    validateDateRange(timeframeStart, timeframeEnd),
    validateUrl(input.sourceUrl, 'Source URL'),
  ].filter(Boolean);
  if (!EVIDENCE_TYPES.includes(evidenceType)) errors.push('Choose a valid evidence type.');
  if (!EVIDENCE_STATUSES.includes(status)) errors.push('Choose VERIFIED, LEARNING, or NO_EVIDENCE as the capability context.');
  if (!SOURCE_TYPES.includes(sourceType)) errors.push('Choose a valid source type.');

  const links = {};
  for (const type of LINK_TYPES) {
    const key = `${type}Ids`;
    const raw = cleanList(input[key]);
    if (Array.isArray(input[key]) && input[key].length > 30) errors.push(`${type} relationships cannot exceed 30 items.`);
    links[type] = raw;
  }

  return {
    errors,
    value: {
      title: String(input.title || '').trim(),
      description: String(input.description || '').trim(),
      evidenceType,
      status,
      sourceType,
      sourceTitle: String(input.sourceTitle || '').trim(),
      sourceReference: String(input.sourceReference || '').trim(),
      sourceUrl: String(input.sourceUrl || '').trim(),
      timeframeStart,
      timeframeEnd,
      notes: String(input.notes || '').trim(),
      links,
    },
  };
}

function parseJsonList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

module.exports = { EVIDENCE_TYPES, EVIDENCE_STATUSES, LINK_TYPES, SOURCE_TYPES, parseJsonList, validateEvidence };
