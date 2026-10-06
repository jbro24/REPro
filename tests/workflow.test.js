const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('../src/app');

class Client {
  constructor(base) { this.base = base; this.cookies = new Map(); }
  updateCookies(response) {
    for (const value of (response.headers.getSetCookie ? response.headers.getSetCookie() : [])) {
      const [pair] = value.split(';');
      const separator = pair.indexOf('=');
      if (separator < 0) continue;
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
  async csrf() { return (await (await this.request('/api/auth/csrf')).json()).csrfToken; }
  async json(route, method, body = {}) {
    const csrf = await this.csrf();
    return this.request(route, { method, headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ ...body, csrf }) });
  }
}

function requirements() {
  return { version: 'job-requirements-v1', requiredSkills: ['Python', 'AWS'], preferredSkills: ['Docker'], responsibilities: ['Deploy reliable services'], experienceRequirements: [], educationRequirements: [], locationRequirements: [], otherConstraints: [] };
}

async function setup({ searchProvider = null, mailboxProvider = null, analystProvider = null } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'career-commander-workflow-'));
  const server = createApp({ dbPath: path.join(directory, 'test.sqlite'), nodeEnv: 'test', searchProvider, mailboxProvider, analystProvider });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, client: new Client(`http://127.0.0.1:${server.address().port}`), directory };
}

async function signup(client, email) {
  const response = await client.json('/api/auth/signup', 'POST', { email, password: 'correct horse battery staple' });
  assert.equal(response.status, 201);
}

async function close(context) {
  await new Promise((resolve) => context.server.close(resolve));
  context.server.database.close();
  fs.rmSync(context.directory, { recursive: true, force: true });
}

test('manual Discover intake automatically produces one consolidated opportunity report', async (t) => {
  const context = await setup({ analystProvider: { analyze: async () => ({ provider: 'mock', model: 'test', output: requirements() }) } });
  t.after(() => close(context));
  await signup(context.client, 'manual-workflow@example.com');
  const response = await context.client.json('/api/discover/manual', 'POST', { title: 'Cloud Systems Engineer', company: 'YCC', location: 'Remote', rawContent: 'Python and AWS required. Docker preferred.' });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.analysis.ok, true);
  assert.equal(payload.opportunity.analysisState, 'COMPLETE');
  const report = await context.client.request(`/api/opportunities/${payload.opportunity.id}/report`);
  assert.equal(report.status, 200);
  const reportPayload = await report.json();
  assert.equal(reportPayload.report.status, 'READY');
  assert.equal(reportPayload.report.report.fitScore.overall, 0);
  assert.match((await (await context.client.request(`/opportunities/${payload.opportunity.id}`)).text()), /OPPORTUNITY REPORT/);
});

test('profile-driven Web and Email discovery converge, deduplicate, preserve provenance, and auto-analyze', async (t) => {
  const job = { title: 'Cloud Systems Engineer', company: 'YCC', location: 'Remote', url: 'https://jobs.example/ycc/cloud', description: 'Python and AWS required.' };
  const context = await setup({
    analystProvider: { analyze: async () => ({ provider: 'mock', model: 'test', output: requirements() }) },
    searchProvider: { search: async ({ queries, profile }) => { assert.match(queries[0], /platform engineer/i); assert.equal(profile.location, 'Remote'); return [job]; } },
    mailboxProvider: { scan: async () => [{ ...job, source: 'Inbox', sourceIdentifier: 'mail-1' }] },
  });
  t.after(() => close(context));
  await signup(context.client, 'discovery-workflow@example.com');
  let response = await context.client.json('/api/profile', 'POST', { name: 'Candidate', targetRoles: ['Platform Engineer'], location: 'Remote', currentStatus: 'seeking', summary: 'Backend engineer.' });
  assert.equal(response.status, 200);
  response = await context.client.json('/api/discover/web/scan', 'POST');
  assert.equal(response.status, 200);
  const webRun = (await response.json()).run;
  assert.equal(webRun.newCount, 1);
  assert.equal(webRun.analyzedCount, 1);
  response = await context.client.json('/api/discover/email/connect', 'POST', { provider: 'MOCK', accountLabel: 'Test mailbox' });
  assert.equal(response.status, 200);
  response = await context.client.json('/api/discover/email/scan', 'POST');
  assert.equal(response.status, 200);
  const emailRun = (await response.json()).run;
  assert.equal(emailRun.duplicateCount, 1);
  assert.equal(emailRun.analyzedCount, 0);
  const list = await context.client.request('/api/opportunities');
  const opportunities = (await list.json()).opportunities;
  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0].queue.analysisState, 'COMPLETE');
  assert.equal(opportunities[0].provenance.length, 2);
  const history = await context.client.request('/api/discovery/runs');
  assert.equal((await history.json()).runs.length, 2);
});

test('provider failures are recorded without losing existing opportunities', async (t) => {
  const context = await setup({ searchProvider: { search: async () => { throw new Error('OmniRoute unavailable'); } } });
  t.after(() => close(context));
  await signup(context.client, 'failure-workflow@example.com');
  const response = await context.client.json('/api/discover/web/scan', 'POST');
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /existing opportunities remain safe/i);
  const runs = await context.client.request('/api/discovery/runs');
  const run = (await runs.json()).runs[0];
  assert.equal(run.status, 'FAILED');
  assert.match(run.errorMessage, /OmniRoute unavailable/);
});

test('authenticated navigation centers Profile, Discover, Opportunities, and human review', async (t) => {
  const context = await setup();
  t.after(() => close(context));
  await signup(context.client, 'navigation-workflow@example.com');
  const response = await context.client.request('/discover');
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const label of ['Dashboard', 'Profile', 'Discover', 'Opportunities', 'Applications', 'Settings']) assert.match(html, new RegExp(`>${label}<`));
  assert.doesNotMatch(html, />Analysis</);
  assert.match(html, /MANUAL/);
  assert.match(html, /WEB SEARCH/);
  assert.match(html, /EMAIL/);
  assert.equal((await context.client.request('/analysis')).status, 302);
});
