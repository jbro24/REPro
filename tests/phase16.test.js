const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('../src/app');

class Client {
  constructor(base) { this.base = base; this.cookies = new Map(); }

  updateCookies(response) {
    const values = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    for (const value of values) {
      const [pair] = value.split(';');
      const separator = pair.indexOf('=');
      if (separator === -1) continue;
      const name = pair.slice(0, separator);
      const cookieValue = pair.slice(separator + 1);
      if (!cookieValue || /Max-Age=0/.test(value)) this.cookies.delete(name);
      else this.cookies.set(name, decodeURIComponent(cookieValue));
    }
  }

  async request(route, options = {}) {
    const headers = new Headers(options.headers || {});
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; '));
    const response = await fetch(`${this.base}${route}`, { ...options, headers, redirect: 'manual' });
    this.updateCookies(response);
    return response;
  }

  async json(route, method, value = {}) {
    const csrfResponse = await this.request('/api/auth/csrf');
    const csrf = (await csrfResponse.json()).csrfToken;
    return this.request(route, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ ...value, csrf }),
    });
  }
}

function requirementsOutput() {
  return {
    version: 'job-requirements-v1',
    requiredSkills: ['Python'],
    preferredSkills: [],
    responsibilities: ['Build services'],
    experienceRequirements: [],
    educationRequirements: [],
    locationRequirements: [],
    otherConstraints: [],
  };
}

async function setup(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'career-commander-phase16-'));
  const server = createApp({
    dbPath: path.join(directory, 'test.sqlite'),
    nodeEnv: 'test',
    analystProvider: { analyze: async () => ({ provider: 'mock', model: 'test', output: requirementsOutput() }) },
    ...overrides,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}`, directory };
}

async function teardown(context) {
  await new Promise((resolve) => context.server.close(resolve));
  context.server.database.close();
  fs.rmSync(context.directory, { recursive: true, force: true });
}

async function signup(client, email) {
  const response = await client.json('/api/auth/signup', 'POST', { email, password: 'correct horse battery staple' });
  assert.equal(response.status, 201);
}

test('Phase 16 keeps deterministic report facts authoritative over enrichment and synthesis', async (t) => {
  const context = await setup({
    companySignalsProvider: {
      signals: async () => ({ provider: 'untrusted-company-provider', signals: [{ certainty: 'INVALID', label: 'Provider label', value: 'Provider interpretation' }] }),
    },
    projectRelevanceProvider: {
      relevance: async () => ({ provider: 'untrusted-project-provider', projects: [
        { projectId: 'not-owned', project: 'Not owned', relevantTechnologies: ['Python'] },
        { project: 'Known project', relevantTechnologies: ['Not actually listed'] },
      ] }),
    },
    reportSynthesisProvider: {
      report: async () => ({ provider: 'summary-provider', summary: 'Readable summary only.', fitScore: { overall: 100 }, gaps: [] }),
    },
  });
  t.after(() => teardown(context));
  const client = new Client(context.base);
  await signup(client, 'phase16-report@example.com');
  const projectResponse = await client.json('/api/projects', 'POST', { name: 'Known project', description: 'Python service', technologies: ['Python'] });
  assert.equal(projectResponse.status, 201);
  const intake = await client.json('/api/discover/manual', 'POST', { title: 'Backend Engineer', company: 'Example Co', rawContent: 'Python required.' });
  assert.equal(intake.status, 201);
  const intakePayload = await intake.json();
  const reportResponse = await client.request(`/api/opportunities/${intakePayload.opportunity.id}/report`);
  const payload = await reportResponse.json();
  assert.equal(payload.freshness.isStale, false);
  assert.equal(payload.report.report.fitScore.overall, 0);
  assert.equal(payload.report.report.gaps.length, 1);
  assert.equal(payload.report.report.evidenceMatch[0].matchState, 'MISSING');
  assert.equal(payload.report.report.synthesizedSummary, 'Readable summary only.');
  assert.equal(payload.companySignals.signals.some((signal) => signal.certainty === 'OBSERVED'), true);
  assert.equal(payload.companySignals.signals.some((signal) => signal.certainty === 'INFERRED'), true);
  assert.equal(payload.relevance.projects.length, 1);
  assert.equal(payload.relevance.projects[0].project, 'Known project');
  assert.match(payload.relevance.projects[0].relevanceBasis, /does not create a match/i);
});

test('Phase 16 marks reports stale after candidate profile changes and hides stale enrichment', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const client = new Client(context.base);
  await signup(client, 'phase16-stale@example.com');
  const intake = await client.json('/api/discover/manual', 'POST', { title: 'Backend Engineer', company: 'Example Co', rawContent: 'Python required.' });
  assert.equal(intake.status, 201);
  const opportunityId = (await intake.json()).opportunity.id;
  const user = context.server.database.getUserByEmail('phase16-stale@example.com');
  const profile = context.server.database.getProfileForUser(user.id);
  context.server.database.updateProfileForUser(user.id, {
    name: profile.name,
    targetRoles: ['Backend Engineer'],
    location: 'India',
    currentStatus: 'Student',
    summary: 'Updated candidate context',
  });
  const reportResponse = await client.request(`/api/opportunities/${opportunityId}/report`);
  const payload = await reportResponse.json();
  assert.equal(payload.freshness.isStale, true);
  assert.ok(payload.freshness.reasons.includes('CANDIDATE_CONTEXT_CHANGED'));
  assert.equal(payload.companySignals, null);
  const opportunityResponse = await client.request(`/api/opportunities/${opportunityId}`);
  assert.equal((await opportunityResponse.json()).opportunity.analysisState, 'STALE');
  const html = await (await client.request(`/opportunities/${opportunityId}`)).text();
  assert.match(html, /Analysis needs refresh/);
  assert.match(html, /STALE/);
});

test('Phase 16 marks reports stale after evidence changes', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const client = new Client(context.base);
  await signup(client, 'phase16-evidence@example.com');
  const intake = await client.json('/api/discover/manual', 'POST', { title: 'Backend Engineer', company: 'Example Co', rawContent: 'Python required.' });
  assert.equal(intake.status, 201);
  const opportunityId = (await intake.json()).opportunity.id;
  const user = context.server.database.getUserByEmail('phase16-evidence@example.com');
  context.server.database.createEvidenceForUser(user.id, {
    title: 'Python learning notes',
    description: 'Candidate-provided notes.',
    evidenceType: 'DOCUMENT',
    status: 'LEARNING',
    sourceType: 'DOCUMENT',
    sourceTitle: 'Local notes',
    sourceReference: 'candidate-provided',
    sourceUrl: '',
    timeframeStart: '',
    timeframeEnd: '',
    notes: '',
    links: [],
  });
  const payload = await (await client.request(`/api/opportunities/${opportunityId}/report`)).json();
  assert.equal(payload.freshness.isStale, true);
  assert.ok(payload.freshness.reasons.includes('CANDIDATE_CONTEXT_CHANGED'));
});

