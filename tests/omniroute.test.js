const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { OmniRouteClient, OmniRouteError } = require('../src/omniRoute');

async function fakeServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('OmniRoute adapter preserves provider boundaries for search and structured chat', async (t) => {
  const calls = [];
  const requestBodies = [];
  const context = await fakeServer((req, res) => {
    calls.push(req.url);
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { if (body) requestBodies.push(JSON.parse(body)); });
    if (req.url === '/v1/search') return json(res, 200, { results: [{ title: 'Role', company: 'Company', description: 'Python role' }] });
    if (req.url === '/v1/chat/completions') return json(res, 200, { model: 'mock-model', choices: [{ message: { content: '```json\n{"version":"job-requirements-v1","requiredSkills":["Python"],"preferredSkills":[],"responsibilities":[],"experienceRequirements":[],"educationRequirements":[],"locationRequirements":[],"otherConstraints":[]}\n```' } }] });
    return json(res, 404, { error: 'not found' });
  });
  t.after(() => context.server.close());
  const logs = [];
  const client = new OmniRouteClient({ baseUrl: context.baseUrl, timeoutMs: 500, maxRetries: 0, logger: { info: (line) => logs.push(JSON.parse(line)) } });
  const search = await client.search({ queries: ['Python jobs'], profile: { targetRoles: ['Engineer'] } });
  const analysis = await client.analyze({ system: 'Interpret only job data.', user: '<JOB_POSTING_DATA>Python</JOB_POSTING_DATA>' });
  assert.equal(search.provider, 'omniroute');
  assert.equal(search.results[0].title, 'Role');
  assert.equal(analysis.output.requiredSkills[0], 'Python');
  assert.deepEqual(calls, ['/v1/search', '/v1/chat/completions']);
  assert.equal(requestBodies[0].query, 'Python jobs');
  assert.equal('queries' in requestBodies[0], false);
  assert.equal(logs.every((entry) => entry.provider === 'omniroute' && typeof entry.durationMs === 'number'), true);
});

test('OmniRoute adapter rejects malformed responses', async (t) => {
  const context = await fakeServer((req, res) => json(res, 200, { unexpected: true }));
  t.after(() => context.server.close());
  const client = new OmniRouteClient({ baseUrl: context.baseUrl, timeoutMs: 500, maxRetries: 0, logger: null });
  await assert.rejects(() => client.search({ queries: ['jobs'], profile: {} }), (error) => error instanceof OmniRouteError && error.code === 'OMNIROUTE_MALFORMED_RESPONSE');
});

test('OmniRoute adapter enforces timeout behavior', async (t) => {
  const context = await fakeServer((req, res) => setTimeout(() => json(res, 200, { results: [] }), 150));
  t.after(() => context.server.close());
  const client = new OmniRouteClient({ baseUrl: context.baseUrl, timeoutMs: 25, maxRetries: 0, logger: null });
  await assert.rejects(() => client.search({ queries: ['jobs'], profile: {} }), (error) => error instanceof OmniRouteError && error.code === 'OMNIROUTE_TIMEOUT');
});

test('OmniRoute adapter retries transient upstream failures and reports retry count', async (t) => {
  let count = 0;
  const context = await fakeServer((req, res) => { count += 1; json(res, 503, { error: 'busy' }); });
  t.after(() => context.server.close());
  const client = new OmniRouteClient({ baseUrl: context.baseUrl, timeoutMs: 500, maxRetries: 1, logger: null });
  await assert.rejects(() => client.search({ queries: ['jobs'], profile: {} }), (error) => error instanceof OmniRouteError && error.code === 'OMNIROUTE_UPSTREAM_FAILURE' && error.retryCount === 1);
  assert.equal(count, 2);
});

test('OmniRoute search provider selection is bounded and falls back only across configured providers', async (t) => {
  const providers = [];
  const context = await fakeServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      providers.push(parsed.provider || 'default');
      if (parsed.provider === 'unavailable') return json(res, 503, { error: 'provider unavailable' });
      return json(res, 200, { results: [{ title: 'Verified role', company: 'Example', description: 'A real posting' }] });
    });
  });
  t.after(() => context.server.close());
  const client = new OmniRouteClient({ baseUrl: context.baseUrl, searchProviders: ['unavailable', 'configured'], timeoutMs: 500, maxRetries: 0, logger: null });
  const result = await client.search({ queries: ['platform engineer jobs'] });
  assert.deepEqual(providers, ['unavailable', 'configured']);
  assert.deepEqual(result.providers, ['unavailable', 'configured']);
  assert.equal(result.results[0].provider, 'configured');
});
