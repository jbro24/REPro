const { toOpportunityPayload } = require('./opportunity');

const DISCOVERY_PROVIDERS = Object.freeze(['OMNIROUTE', 'GMAIL', 'OUTLOOK', 'MOCK']);

function profileView(profile, skills = []) {
  let targetRoles = [];
  try { targetRoles = JSON.parse(profile?.target_roles_json || '[]'); } catch {}
  return {
    name: profile?.name || '',
    targetRoles: Array.isArray(targetRoles) ? targetRoles : [],
    location: profile?.location || '',
    currentStatus: profile?.current_status || '',
    summary: profile?.summary || '',
    skills: skills.map((skill) => ({ name: skill.name, status: skill.status })),
  };
}

function buildSearchQueries(profile, skills = []) {
  const context = profileView(profile, skills);
  const roles = context.targetRoles.length ? context.targetRoles : ['software engineer'];
  const location = context.location ? ` ${context.location}` : '';
  const technologies = context.skills.filter((skill) => skill.status !== 'NO_EVIDENCE').slice(0, 8).map((skill) => skill.name);
  return roles.slice(0, 10).map((role) => {
    const technologyClause = technologies.length ? ` ${technologies.slice(0, 4).join(' ')}` : '';
    return `${role}${location}${technologyClause} jobs`;
  });
}

function normalizeDiscoveryResult(result, sourceType) {
  if (!result || typeof result !== 'object') return { errors: ['Result was not an object.'] };
  return toOpportunityPayload({
    title: result.title || result.jobTitle,
    company: result.company || result.organization,
    location: result.location,
    url: result.url || result.jobUrl,
    rawContent: result.rawContent || result.description || result.body,
    sourceType,
    sourceIdentifier: result.sourceIdentifier || result.id || '',
    sourceReference: result.sourceReference || result.source || '',
    sourceTimestamp: result.sourceTimestamp || result.receivedAt || result.publishedAt || '',
    provenanceMetadata: result.provenanceMetadata || result.metadata || {},
  });
}

function resultList(output) {
  if (Array.isArray(output)) return output;
  if (Array.isArray(output?.results)) return output.results;
  if (Array.isArray(output?.opportunities)) return output.opportunities;
  if (Array.isArray(output?.messages)) return output.messages;
  return [];
}

module.exports = { DISCOVERY_PROVIDERS, buildSearchQueries, normalizeDiscoveryResult, profileView, resultList };
