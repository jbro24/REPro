const { roadmapForGaps } = require('./roadmap');

async function invoke(provider, method, payload) {
  if (typeof provider === 'function') return provider(payload);
  if (provider && typeof provider[method] === 'function') return provider[method](payload);
  throw new Error(`Agent method ${method} is unavailable.`);
}

function tokenSet(value) {
  return new Set(String(value || '').toLowerCase().split(/[^a-z0-9+#.]+/).filter((token) => token.length > 1));
}

function deterministicProjectRelevance(projects = [], requirements = {}) {
  const requirementsByName = [
    ...(requirements.requiredSkills || []),
    ...(requirements.preferredSkills || []),
  ];
  return projects.map((project) => {
    const projectTokens = tokenSet([project.name, project.description, ...(project.technologies || [])].join(' '));
    const supports = requirementsByName.filter((requirement) => projectTokens.has(String(requirement.name || requirement).toLowerCase()));
    return {
      projectId: project.id,
      project: project.name,
      relevantTechnologies: supports.map((item) => item.name || item),
      whyRelevant: supports.length ? `The project records work with ${supports.map((item) => item.name || item).join(', ')}.` : '',
      requirementIds: supports.map((item) => item.id || item.name || item),
    };
  }).filter((item) => item.relevantTechnologies.length);
}

function observedSignals(opportunity, requirements) {
  const signals = [];
  if (requirements?.responsibilities?.length) signals.push({ label: 'Responsibilities emphasized', value: requirements.responsibilities.map((item) => item.text || item).join('; '), certainty: 'OBSERVED', source: 'Structured job posting' });
  if (requirements?.requiredSkills?.length) signals.push({ label: 'Required technologies and skills', value: requirements.requiredSkills.map((item) => item.name || item).join(', '), certainty: 'OBSERVED', source: 'Structured job posting' });
  if (requirements?.preferredSkills?.length) signals.push({ label: 'Preferred technologies and skills', value: requirements.preferredSkills.map((item) => item.name || item).join(', '), certainty: 'OBSERVED', source: 'Structured job posting' });
  if (opportunity?.rawContent) signals.push({ label: 'Domain and working context', value: 'The posting contains additional context that has not been independently verified.', certainty: 'INFERRED', source: 'Job posting interpretation' });
  return signals;
}

const SIGNAL_CERTAINTIES = new Set(['OBSERVED', 'INFERRED']);

function normalizeSignals(signals = [], { defaultCertainty = 'INFERRED', defaultSource = 'Enrichment provider output' } = {}) {
  return (Array.isArray(signals) ? signals : []).filter((signal) => signal && typeof signal === 'object').map((signal) => ({
    label: String(signal.label || 'Signal').trim().slice(0, 240),
    value: String(signal.value || '').trim().slice(0, 2000),
    certainty: SIGNAL_CERTAINTIES.has(signal.certainty) ? signal.certainty : defaultCertainty,
    source: String(signal.source || defaultSource).trim().slice(0, 500),
    provenance: String(signal.provenance || signal.source || defaultSource).trim().slice(0, 500),
  })).filter((signal) => signal.label && signal.value);
}

function normalizedProjectName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeProjectRelevance(providerProjects, candidateProjects, requirements) {
  const deterministic = deterministicProjectRelevance(candidateProjects, requirements);
  const deterministicByProject = new Map(deterministic.map((item) => [item.projectId, item]));
  const byId = new Map(candidateProjects.map((project) => [project.id, project]));
  const byName = new Map(candidateProjects.map((project) => [normalizedProjectName(project.name), project]));
  const items = (Array.isArray(providerProjects) ? providerProjects : []).map((item) => {
    const project = byId.get(item?.projectId) || byName.get(normalizedProjectName(item?.project || item?.name));
    if (!project) return null;
    const baseline = deterministicByProject.get(project.id);
    const actualTechnologies = new Set((project.technologies || []).map((technology) => normalizedProjectName(technology)));
    const relevantTechnologies = (Array.isArray(item.relevantTechnologies) ? item.relevantTechnologies : [])
      .map((technology) => String(technology || '').trim())
      .filter((technology) => actualTechnologies.has(normalizedProjectName(technology)));
    return {
      projectId: project.id,
      project: project.name,
      relevantTechnologies: relevantTechnologies.length ? relevantTechnologies : (baseline?.relevantTechnologies || []),
      requirementIds: baseline?.requirementIds || [],
      whyRelevant: String(item.whyRelevant || baseline?.whyRelevant || 'The project record may be relevant to this opportunity; review the source details before treating it as support.').trim().slice(0, 1000),
      relevanceBasis: 'Candidate-owned project context; project relevance does not create a match or verify a skill.',
    };
  }).filter(Boolean);
  return items.length ? items : deterministic.map((item) => ({ ...item, relevanceBasis: 'Candidate-owned project context; project relevance does not create a match or verify a skill.' }));
}

async function enrichOpportunity({ agents, opportunity, requirements, gaps, projects }) {
  const observed = normalizeSignals(observedSignals(opportunity, requirements), { defaultCertainty: 'OBSERVED', defaultSource: 'Structured job posting' });
  let companySignals = { status: 'UNAVAILABLE', provider: '', signals: observed, errorMessage: 'No company-signals provider is configured; observed signals come only from the job posting.' };
  if (agents.companySignals) {
    try {
      const output = await invoke(agents.companySignals, 'signals', { opportunity, requirements });
      const providerSignals = normalizeSignals(output?.signals, { defaultCertainty: 'INFERRED' });
      companySignals = { status: 'READY', provider: output?.provider || 'configured-provider', signals: [...observed, ...providerSignals] };
    } catch (error) {
      companySignals = { status: 'FAILED', provider: agents.companySignals.name || '', signals: observed, errorMessage: 'Company signals could not be retrieved; source-grounded signals remain available.' };
    }
  }

  let relevance = { status: 'READY', provider: 'deterministic-profile-context', projects: normalizeProjectRelevance([], projects, requirements) };
  if (agents.projectRelevance) {
    try {
      const output = await invoke(agents.projectRelevance, 'relevance', { opportunity, requirements, projects });
      relevance = { status: 'READY', provider: output?.provider || 'configured-provider', projects: normalizeProjectRelevance(output?.projects, projects, requirements) };
    } catch {
      relevance = { status: 'FAILED', provider: agents.projectRelevance.name || '', projects: normalizeProjectRelevance([], projects, requirements), errorMessage: 'Project relevance could not be retrieved; deterministic project context remains available.' };
    }
  }

  const roadmap = roadmapForGaps(gaps);
  return { companySignals, relevance, roadmap };
}

module.exports = { deterministicProjectRelevance, enrichOpportunity, invoke, normalizeProjectRelevance, normalizeSignals, observedSignals };
