const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('../src/app');
const { roadmapForGaps } = require('../src/roadmap');

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
  async json(route, method, body = {}) {
    const csrf = (await (await this.request('/api/auth/csrf')).json()).csrfToken;
    return this.request(route, { method, headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ ...body, csrf }) });
  }
}

async function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'career-commander-phase13-'));
  const requirements = { version: 'job-requirements-v1', requiredSkills: ['AWS'], preferredSkills: ['Docker'], responsibilities: [], experienceRequirements: [], educationRequirements: [], locationRequirements: [], otherConstraints: [] };
  const server = createApp({ dbPath: path.join(directory, 'test.sqlite'), nodeEnv: 'test', analystProvider: { analyze: async () => ({ provider: 'mock', model: 'test', output: requirements }) } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, directory, client: new Client(`http://127.0.0.1:${server.address().port}`) };
}

async function close(context) {
  await new Promise((resolve) => context.server.close(resolve));
  context.server.database.close();
  fs.rmSync(context.directory, { recursive: true, force: true });
}

async function signup(client, email) {
  const response = await client.json('/api/auth/signup', 'POST', { email, password: 'correct horse battery staple' });
  assert.equal(response.status, 201);
}

async function json(client, route, method, body = {}) {
  const response = await client.json(route, method, body);
  const payload = response.status === 204 ? null : await response.json();
  return { response, payload };
}

test('Phase 13 roadmap and application workflow remains grounded and owner-scoped', async (t) => {
  const context = await setup();
  t.after(() => close(context));
  await signup(context.client, 'phase13-owner@example.com');
  const initialDashboard = await context.client.request('/dashboard');
  assert.equal(initialDashboard.status, 200);
  assert.match(await initialDashboard.text(), /ATTENTION QUEUE/);

  const skill = await json(context.client, '/api/skills', 'POST', { name: 'Python', status: 'VERIFIED', supportingReference: 'Backend project implementation.' });
  assert.equal(skill.response.status, 201);
  const evidence = await json(context.client, '/api/evidence', 'POST', { title: 'Backend repository', description: 'Repository shows backend implementation.', evidenceType: 'REPOSITORY', status: 'VERIFIED', sourceType: 'REPOSITORY', sourceReference: 'Repository review notes', sourceUrl: 'https://example.com/repository', skillIds: [skill.payload.skills.id] });
  assert.equal(evidence.response.status, 201);
  const profile = await json(context.client, '/api/profile', 'POST', { name: 'Candidate', targetRoles: ['Cloud Engineer'], location: 'India', currentStatus: 'student', summary: 'Backend-focused computer science student.' });
  assert.equal(profile.response.status, 200);

  const intake = await json(context.client, '/api/discover/manual', 'POST', { title: 'Cloud Engineer', company: 'Example Co', location: 'India', rawContent: 'AWS required. Docker preferred.' });
  assert.equal(intake.response.status, 201);
  assert.equal(intake.payload.analysis.ok, true);
  const opportunityId = intake.payload.opportunity.id;

  const reportBefore = await context.client.request(`/api/opportunities/${opportunityId}/report`);
  const reportPayloadBefore = await reportBefore.json();
  const roadmap = reportPayloadBefore.roadmap;
  assert.equal(roadmap.length, 2);
  assert.equal(roadmap[0].priority, 'REQUIRED');
  assert.equal(roadmap[0].status, 'PLANNED');
  assert.match(roadmap[0].task, /AWS/i);
  assert.match(roadmap[0].potentialEvidence, /deployment|architecture|repository/i);
  assert.equal(roadmap[1].priority, 'PREFERRED');
  const scoreBefore = reportPayloadBefore.report.report.fitScore.overall;
  const gapsBefore = reportPayloadBefore.report.report.gaps.map((gap) => gap.requirementText);

  const status = await json(context.client, `/api/roadmap-items/${roadmap[0].id}/status`, 'POST', { status: 'IN_PROGRESS', next: `/opportunities/${opportunityId}` });
  assert.equal(status.response.status, 200);
  assert.equal(status.payload.roadmap.status, 'IN_PROGRESS');

  const link = await json(context.client, `/api/roadmap-items/${roadmap[0].id}/evidence`, 'POST', { evidenceId: evidence.payload.evidence.id, next: `/opportunities/${opportunityId}` });
  assert.equal(link.response.status, 200);
  assert.equal(link.payload.roadmap.evidence.length, 1);
  const unlink = await json(context.client, `/api/roadmap-items/${roadmap[0].id}/evidence/${evidence.payload.evidence.id}/unlink`, 'POST', { next: `/opportunities/${opportunityId}` });
  assert.equal(unlink.response.status, 200);
  assert.equal(unlink.payload.roadmap.deleted, true);
  const relink = await json(context.client, `/api/roadmap-items/${roadmap[0].id}/evidence`, 'POST', { evidenceId: evidence.payload.evidence.id, next: `/opportunities/${opportunityId}` });
  assert.equal(relink.payload.roadmap.evidence.length, 1);

  const application = await json(context.client, `/api/opportunities/${opportunityId}/application`, 'POST');
  assert.equal(application.response.status, 201);
  assert.equal(application.payload.application.status, 'DRAFT');
  assert.match(application.payload.application.draftText, /Cloud Engineer/);
  assert.ok(application.payload.application.claims.length > 0);
  assert.equal(application.payload.application.claimSummary.unsupported, 0);
  assert.equal(application.payload.application.stale, false);
  assert.equal(application.payload.application.sourceSnapshot.version, 'application-source-v1');
  const applicationId = application.payload.application.id;

  const edited = await json(context.client, `/api/applications/${applicationId}`, 'POST', { draftText: 'I have professional AWS experience.' });
  assert.equal(edited.response.status, 200);
  assert.equal(edited.payload.application.claimSummary.unsupported, 1);
  assert.equal(edited.payload.application.claims[0].verdict, 'UNSUPPORTED');

  const reviewed = await json(context.client, `/api/applications/${applicationId}/review`, 'POST', { reviewNote: 'Reviewed claim support.' });
  assert.equal(reviewed.response.status, 200);
  assert.equal(reviewed.payload.application.status, 'READY_FOR_REVIEW');
  const applicationHtml = await (await context.client.request(`/applications/${applicationId}`)).text();
  assert.match(applicationHtml, /UNSUPPORTED/);
  assert.doesNotMatch(applicationHtml, /Submit application/i);

  const changedProfile = await json(context.client, '/api/profile', 'POST', { name: 'Candidate Updated', targetRoles: ['Cloud Engineer'], location: 'India', currentStatus: 'student', summary: 'Updated evidence context.' });
  assert.equal(changedProfile.response.status, 200);
  const staleApplication = await (await context.client.request(`/api/applications/${applicationId}`)).json();
  assert.equal(staleApplication.application.stale, true);
  const staleReview = await json(context.client, `/api/applications/${applicationId}/review`, 'POST', { reviewNote: 'Should be blocked until refreshed.' });
  assert.equal(staleReview.response.status, 409);
  const refreshed = await json(context.client, `/api/applications/${applicationId}`, 'POST', { draftText: 'I am interested in this opportunity.' });
  assert.equal(refreshed.response.status, 200);
  assert.equal(refreshed.payload.application.stale, true);

  const reportAfter = await (await context.client.request(`/api/opportunities/${opportunityId}/report`)).json();
  assert.equal(reportAfter.report.report.fitScore.overall, scoreBefore);
  assert.deepEqual(reportAfter.report.report.gaps.map((gap) => gap.requirementText), gapsBefore);

  const other = new Client(context.client.base);
  await signup(other, 'phase13-other@example.com');
  assert.equal((await other.request(`/api/applications/${applicationId}`)).status, 404);
  assert.equal((await json(other, `/api/roadmap-items/${roadmap[0].id}/status`, 'POST', { status: 'COMPLETED' })).response.status, 404);
  assert.equal((await json(other, `/api/roadmap-items/${roadmap[0].id}/evidence/${evidence.payload.evidence.id}/unlink`, 'POST', {})).response.status, 404);

  const deleted = await json(context.client, `/api/opportunities/${opportunityId}/delete`, 'POST', {});
  assert.equal(deleted.response.status, 204);
  assert.equal((await context.client.request(`/api/applications/${applicationId}`)).status, 404);
  assert.equal((await context.client.request(`/api/opportunities/${opportunityId}/roadmap`)).status, 404);
});

test('Phase 13 roadmap generation is deterministic and empty gaps create no work', () => {
  assert.deepEqual(roadmapForGaps([]), []);
  const roadmap = roadmapForGaps([
    { requirementId: 'preferred', priority: 'PREFERRED', gapState: 'MISSING', requirementText: 'Docker' },
    { requirementId: 'required', priority: 'REQUIRED', gapState: 'PARTIAL', requirementText: 'AWS' },
  ]);
  assert.equal(roadmap[0].priority, 'REQUIRED');
  assert.match(roadmap[0].task, /Deploy.*AWS/i);
  assert.match(roadmap[1].task, /Containerize.*Docker/i);
  assert.equal(roadmap[0].status, 'PLANNED');
});
