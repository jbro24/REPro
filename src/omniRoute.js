const DEFAULT_BASE_URL = 'http://localhost:20128/v1';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_SEARCH_LIMIT = 8;

class OmniRouteError extends Error {
  constructor(message, { code = 'OMNIROUTE_ERROR', status = 0, stage = 'request', retryCount = 0 } = {}) {
    super(message);
    this.name = 'OmniRouteError';
    this.code = code;
    this.status = status;
    this.stage = stage;
    this.retryCount = retryCount;
  }
}

function numberEnv(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function listEnv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean).slice(0, 4);
}

function stripJsonFence(value) {
  return String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function contentFromResponse(response) {
  if (response && typeof response.output === 'object' && response.output !== null) return response.output;
  if (response && typeof response.data === 'object' && response.data !== null && !Array.isArray(response.data)) return response.data;
  const content = response?.choices?.[0]?.message?.content ?? response?.choices?.[0]?.text;
  if (Array.isArray(content)) return content.map((part) => part.text || '').join('');
  if (typeof content === 'string') return JSON.parse(stripJsonFence(content));
  throw new OmniRouteError('OmniRoute returned no structured chat content.', { code: 'OMNIROUTE_MALFORMED_RESPONSE', stage: 'chat' });
}

function resultArray(response) {
  const values = Array.isArray(response) ? response : response?.results || response?.opportunities || response?.data;
  if (!Array.isArray(values)) throw new OmniRouteError('OmniRoute search returned no result array.', { code: 'OMNIROUTE_MALFORMED_RESPONSE', stage: 'search' });
  return values;
}

function createOmniRouteFromEnv(env = process.env) {
  return new OmniRouteClient({
    baseUrl: env.OMNIROUTE_BASE_URL || DEFAULT_BASE_URL,
    apiKey: env.OMNIROUTE_API_KEY || '',
    model: env.OMNIROUTE_MODEL || '',
    timeoutMs: numberEnv(env.OMNIROUTE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 250, 120000),
    maxRetries: numberEnv(env.OMNIROUTE_MAX_RETRIES, DEFAULT_MAX_RETRIES, 0, 3),
    searchLimit: numberEnv(env.OMNIROUTE_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT, 1, 10),
    searchProviders: listEnv(env.OMNIROUTE_SEARCH_PROVIDERS || env.OMNIROUTE_SEARCH_PROVIDER),
    fetchImpl: globalThis.fetch,
    logger: env.OMNIROUTE_LOGGING === 'false' ? null : console,
  });
}

class OmniRouteClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, apiKey = '', model = '', timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = DEFAULT_MAX_RETRIES, searchLimit = DEFAULT_SEARCH_LIMIT, searchProviders = [], fetchImpl = globalThis.fetch, logger = console } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required for OmniRoute.');
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.apiKey = String(apiKey || '');
    this.model = String(model || '');
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.searchLimit = searchLimit;
    this.searchProviders = Array.isArray(searchProviders) ? searchProviders.map((item) => String(item).trim()).filter(Boolean).slice(0, 4) : [];
    this.fetchImpl = fetchImpl;
    this.logger = logger;
  }

  endpoint(pathname) {
    return new URL(pathname.replace(/^\//, ''), `${this.baseUrl}/`).toString();
  }

  log(stage, endpointType, durationMs, success, retryCount) {
    if (!this.logger?.info) return;
    this.logger.info(JSON.stringify({ provider: 'omniroute', endpointType, stage, durationMs, success, retryCount }));
  }

  async requestJson(pathname, body, { stage, endpointType = stage } = {}) {
    let retryCount = 0;
    while (true) {
      const started = Date.now();
      try {
        const headers = { 'content-type': 'application/json', accept: 'application/json' };
        if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
        const response = await this.fetchImpl(this.endpoint(pathname), {
          method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await response.text();
        let parsed;
        try { parsed = text ? JSON.parse(text) : null; } catch { throw new OmniRouteError('OmniRoute returned invalid JSON.', { code: 'OMNIROUTE_MALFORMED_RESPONSE', status: response.status, stage, retryCount }); }
        if (!response.ok) throw new OmniRouteError(`OmniRoute request failed with status ${response.status}.`, { code: 'OMNIROUTE_UPSTREAM_FAILURE', status: response.status, stage, retryCount });
        this.log(stage, endpointType, Date.now() - started, true, retryCount);
        return parsed;
      } catch (error) {
        const transient = error instanceof OmniRouteError
          ? (error.code === 'OMNIROUTE_UPSTREAM_FAILURE' && (error.status === 408 || error.status === 429 || error.status >= 500))
          : error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.code === 'ECONNREFUSED' || error?.code === 'ECONNRESET' || error?.cause?.code === 'ECONNREFUSED' || error?.cause?.code === 'ECONNRESET';
        this.log(stage, endpointType, Date.now() - started, false, retryCount);
        if (transient && retryCount < this.maxRetries) { retryCount += 1; continue; }
        if (error instanceof OmniRouteError) throw error;
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new OmniRouteError('OmniRoute request timed out.', { code: 'OMNIROUTE_TIMEOUT', stage, retryCount });
        throw new OmniRouteError('OmniRoute could not be reached.', { code: 'OMNIROUTE_UNREACHABLE', stage, retryCount });
      }
    }
  }

  async search({ queries = [] }) {
    const requestedQueries = Array.isArray(queries) ? queries.filter((query) => String(query || '').trim()).slice(0, 10) : [];
    if (!requestedQueries.length) throw new OmniRouteError('OmniRoute search requires at least one query.', { code: 'OMNIROUTE_INVALID_REQUEST', stage: 'search' });
    const providers = this.searchProviders.length ? this.searchProviders : [null];
    const results = [];
    const attemptedProviders = [];
    let lastError = null;
    for (const provider of providers) {
      attemptedProviders.push(provider || 'default');
      try {
        for (const query of requestedQueries) {
          const response = await this.requestJson('/search', { query: String(query).trim(), ...(provider ? { provider } : {}) }, { stage: 'search', endpointType: 'search' });
          results.push(...resultArray(response).map((result) => ({ ...result, provider: result?.provider || provider || 'omniroute' })));
          if (results.length >= this.searchLimit) break;
        }
        if (results.length) break;
      } catch (error) {
        lastError = error;
        if (providers.length === 1) throw error;
      }
    }
    if (!results.length && lastError) throw lastError;
    const seen = new Set();
    const deduplicated = results.filter((result) => {
      const key = String(result?.url || result?.id || `${result?.title || ''}|${result?.company || ''}`).trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { provider: 'omniroute', providers: attemptedProviders, results: deduplicated.slice(0, this.searchLimit) };
  }

  async analyze(request) {
    const response = await this.requestJson('/chat/completions', {
      ...(this.model ? { model: this.model } : {}),
      messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }],
      temperature: 0,
    }, { stage: 'job-analysis', endpointType: 'chat' });
    return { provider: 'omniroute', model: response.model || this.model, output: contentFromResponse(response) };
  }

  async signals({ opportunity, requirements }) {
    const output = await this.chatJson('company-signals', 'Extract only observed or explicitly inferred signals from this job data. Return {"signals":[{"label":"","value":"","certainty":"OBSERVED|INFERRED","source":""}]}.', { opportunity: { title: opportunity.title, company: opportunity.company, rawContent: opportunity.rawContent }, requirements });
    return { provider: 'omniroute', signals: Array.isArray(output.signals) ? output.signals : [] };
  }

  async relevance({ opportunity, requirements, projects }) {
    const output = await this.chatJson('project-relevance', 'Compare the candidate projects to the structured requirements. Return only {"projects":[{"projectId":"","project":"","relevantTechnologies":[],"whyRelevant":"","requirementIds":[]}]}. Do not invent projects or override deterministic matching.', { opportunity: { title: opportunity.title, company: opportunity.company }, requirements, projects });
    return { provider: 'omniroute', projects: Array.isArray(output.projects) ? output.projects : [] };
  }

  async report({ facts }) {
    const output = await this.chatJson('report-synthesis', 'Summarize these already-decided facts without changing score, match states, gaps, or evidence. Return only {"summary":""}.', facts);
    return { provider: 'omniroute', summary: String(output.summary || '') };
  }

  async chatJson(stage, instruction, facts) {
    const request = { system: instruction, user: `<STRUCTURED_FACTS>\n${JSON.stringify(facts)}\n</STRUCTURED_FACTS>` };
    const response = await this.requestJson('/chat/completions', {
      ...(this.model ? { model: this.model } : {}),
      messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }],
      temperature: 0,
    }, { stage, endpointType: 'chat' });
    return contentFromResponse(response);
  }
}

module.exports = { DEFAULT_BASE_URL, OmniRouteClient, OmniRouteError, createOmniRouteFromEnv, contentFromResponse, resultArray };
