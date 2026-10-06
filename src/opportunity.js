const crypto = require('node:crypto');
const { validateUrl } = require('./profile');

const OPPORTUNITY_SOURCES = Object.freeze(['MANUAL', 'INTERNET', 'EMAIL']);
const OPPORTUNITY_STATUSES = Object.freeze(['NEW', 'ANALYZED', 'ARCHIVED']);
const MAX_DESCRIPTION_LENGTH = 30000;

function text(value, maxLength, { required = false, field = 'Value' } = {}) {
  const result = typeof value === 'string' ? value : '';
  if (required && !result.trim()) return `${field} is required.`;
  if (result.length > maxLength) return `${field} must be ${maxLength} characters or fewer.`;
  return null;
}

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function canonicalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) parsed.port = '';
    parsed.hash = '';
    if (parsed.pathname === '/') parsed.pathname = '';
    return parsed.toString();
  } catch {
    return raw;
  }
}

function normalizeTimestamp(value, field = 'Source timestamp') {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  const timestamp = new Date(raw);
  if (Number.isNaN(timestamp.getTime())) return `${field} must be a valid timestamp.`;
  return null;
}

function normalizeMetadata(value) {
  if (value === undefined || value === null || value === '') return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > 4000) return null;
    return value;
  } catch {
    return null;
  }
}

function validateOpportunityPayload(input) {
  input = input && typeof input === 'object' ? input : {};
  const sourceType = String(input.sourceType || 'MANUAL').trim().toUpperCase();
  const url = String(input.url || '').trim();
  const sourceIdentifier = String(input.sourceIdentifier || '').trim();
  const sourceReference = String(input.sourceReference || '').trim();
  const rawContent = typeof input.rawContent === 'string' ? input.rawContent : (typeof input.description === 'string' ? input.description : '');
  const errors = [
    text(input.title, 180, { required: true, field: 'Title' }),
    text(input.company, 180, { required: true, field: 'Company' }),
    text(input.location, 180, { field: 'Location' }),
    text(rawContent, MAX_DESCRIPTION_LENGTH, { required: true, field: 'Job description' }),
    text(sourceIdentifier, 300, { field: 'Source identifier' }),
    text(sourceReference, 500, { field: 'Source reference' }),
    validateUrl(url, 'Job URL'),
    normalizeTimestamp(input.sourceTimestamp),
  ].filter(Boolean);
  if (!OPPORTUNITY_SOURCES.includes(sourceType)) errors.push('Choose MANUAL, INTERNET, or EMAIL as the source.');
  if (input.lifecycleStatus && !OPPORTUNITY_STATUSES.includes(String(input.lifecycleStatus).trim().toUpperCase())) errors.push('Choose a valid opportunity status.');
  const metadata = normalizeMetadata(input.provenanceMetadata);
  if (metadata === null) errors.push('Provenance metadata must be a JSON object of 4000 characters or fewer.');
  return {
    errors,
    value: {
      title: String(input.title || '').trim(),
      company: String(input.company || '').trim(),
      location: String(input.location || '').trim(),
      rawContent,
      url,
      canonicalUrl: canonicalizeUrl(url),
      sourceType,
      sourceIdentifier,
      sourceReference,
      sourceTimestamp: input.sourceTimestamp && !normalizeTimestamp(input.sourceTimestamp) ? new Date(input.sourceTimestamp).toISOString() : null,
      lifecycleStatus: String(input.lifecycleStatus || 'NEW').trim().toUpperCase(),
      provenanceMetadata: metadata || {},
    },
  };
}

function normalizeOpportunity(value) {
  const normalizedTitle = normalizeText(value.title);
  const normalizedCompany = normalizeText(value.company);
  const normalizedContent = normalizeText(value.rawContent);
  const dedupeKey = value.canonicalUrl
    ? `url:${value.canonicalUrl}`
    : `content:${normalizedCompany}|${normalizedTitle}|${normalizedContent}`;
  return { normalizedTitle, normalizedCompany, normalizedContent, dedupeKey, contentHash: crypto.createHash('sha256').update(normalizedContent).digest('hex') };
}

function toOpportunityPayload(input) {
  const result = validateOpportunityPayload(input);
  if (result.errors.length) return result;
  return { errors: [], value: { ...result.value, ...normalizeOpportunity(result.value) } };
}

module.exports = {
  MAX_DESCRIPTION_LENGTH,
  OPPORTUNITY_SOURCES,
  OPPORTUNITY_STATUSES,
  canonicalizeUrl,
  normalizeOpportunity,
  normalizeText,
  toOpportunityPayload,
  validateOpportunityPayload,
};
