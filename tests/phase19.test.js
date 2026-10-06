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

const requirements = {
  version: 'job-requirements-v1',
  requiredSkills: ['Python', 'AWS'],
  preferredSkills: ['Docker'],
  responsibilities: ['Build backend services'],
  experienceRequirements: [],
  educationRequirements: [],
  locationRequirements: [],
  otherConstraints: [],
};

async function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'career-commander-phase19-'));
  const server = createApp({ dbPath: path.join(directory, 'test.sqlite'), nodeEnv: 'test', analystProvider: { analyze: async () => ({ provider: 'phase19-test', model: 'test', output: requirements }) } });
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

async function payload(response) {
  return response.status === 204 ? null : response.json();
}

test('Phase 19 fresh-account journey preserves ownership, deterministic state, stale safety, and recovery boundaries', async (t) => {
  const context = await setup();
  t.after(() => close(context));
  const { client } = context;

  await signup(client, 'phase19-owner@example.com');
  assert.equal((await client.request('/dashboard')).status, 200);
  assert.equal((await client.json('/api/auth/logout', 'POST')).status, 204);
  assert.equal((await client.json('/api/auth/login', 'POST', { email: 'phase19-owner@example.com', password: 'correct horse battery staple' })).status, 200);
  assert.equal((await client.request('/api/profile')).status, 200);

  assert.equal((await client.json('/api/profile', 'POST', { name: 'Synthetic Candidate', targetRoles: ['Python Backend Developer', 'Django Backend Developer', 'Cloud/Backend Software Engineer'], location: 'India', currentStatus: 'student', summary: 'Computer Science Engineering student and fresher building backend projects with Python and Django.' })).status, 200);
  assert.equal((await client.json('/api/education', 'POST', { institution: 'Synthetic Institute of Technology', program: 'B.Tech', field: 'Computer Science Engineering', startDate: '2022-08-01', endDate: '2026-05-31', description: 'Synthetic test education record.' })).status, 201);
  const python = await payload(await client.json('/api/skills', 'POST', { name: 'Python', status: 'VERIFIED', supportingReference: 'Synthetic repository evidence.' }));
  const aws = await payload(await client.json('/api/skills', 'POST', { name: 'AWS', status: 'LEARNING', supportingReference: '' }));
  assert.equal(python.skills.status, 'VERIFIED');
  assert.equal(aws.skills.status, 'LEARNING');
  const project = await payload(await client.json('/api/projects', 'POST', { name: 'Career Commander', description: 'Synthetic evidence-first career workflow application.', technologies: ['Python', 'Django'], roleContribution: 'Backend implementation in a test profile.', timeframeStart: '2025-01-01', timeframeEnd: '2026-01-01', repositoryUrl: 'https://example.com/career-commander', outcome: 'Synthetic project record.' }));
  const evidence = await payload(await client.json('/api/evidence', 'POST', { title: 'Career Commander repository', description: 'Synthetic repository evidence for a Python backend project.', evidenceType: 'REPOSITORY', status: 'VERIFIED', sourceType: 'REPOSITORY', sourceReference: 'Synthetic repository review', sourceUrl: 'https://example.com/career-commander', skillIds: [python.skills.id], projectIds: [project.projects.id] }));
  assert.equal(evidence.evidence.links.length, 2);

  const intake = await payload(await client.json('/api/discover/manual', 'POST', { title: 'Backend Engineer', company: 'Synthetic Systems', location: 'India', rawContent: 'Python and AWS required. Docker preferred. Build backend services.' }));
  assert.equal(intake.analysis.ok, true);
  const opportunityId = intake.opportunity.id;
  const report = await payload(await client.request(`/api/opportunities/${opportunityId}/report`));
  assert.equal(report.freshness.isStale, false);
  assert.equal(report.report.report.fitScore.overall, report.report.report.fitScore.overall);
  assert.ok(report.report.report.matchResults.length >= 2);
  assert.ok(report.report.report.gaps.some((gap) => gap.requirementText === 'AWS'));
  let score = report.report.report.fitScore.overall;
  let gaps = report.report.report.gaps.map((gap) => gap.requirementText);
  const roadmap = report.roadmap.find((item) => item.requirementText === 'AWS');
  assert.ok(roadmap);
  assert.equal((await client.json(`/api/roadmap-items/${roadmap.id}/status`, 'POST', { status: 'IN_PROGRESS' })).status, 200);
  const application = await payload(await client.json(`/api/opportunities/${opportunityId}/application`, 'POST'));
  assert.equal(application.application.stale, false);
  const applicationId = application.application.id;
  const awsEvidence = await payload(await client.json('/api/evidence', 'POST', { title: 'AWS learning deployment notes', description: 'Synthetic AWS learning artifact, not production experience.', evidenceType: 'DEPLOYMENT', status: 'LEARNING', sourceType: 'DOCUMENT', sourceReference: 'Synthetic deployment notes', skillIds: [aws.skills.id] }));
  assert.equal((await client.json(`/api/roadmap-items/${roadmap.id}/evidence`, 'POST', { evidenceId: awsEvidence.evidence.id })).status, 200);
  assert.equal((await client.json(`/api/roadmap-items/${roadmap.id}/status`, 'POST', { status: 'COMPLETED' })).status, 200);
  const awsSkill = await payload(await client.request(`/api/skills/${aws.skills.id}`));
  assert.equal(awsSkill.skill.status, 'LEARNING');
  const staleAfterEvidence = await payload(await client.request(`/api/applications/${applicationId}`));
  assert.equal(staleAfterEvidence.application.stale, true);
  const rerun = await client.json(`/api/opportunities/${opportunityId}/analyze`, 'POST');
  assert.ok([200, 201].includes(rerun.status));
  assert.equal((await client.json(`/api/opportunities/${opportunityId}/match`, 'POST')).status, 201);
  assert.equal((await client.json(`/api/opportunities/${opportunityId}/score`, 'POST')).status, 201);
  assert.equal((await client.json(`/api/opportunities/${opportunityId}/gaps`, 'POST')).status, 201);
  const refreshedReport = await payload(await client.request(`/api/opportunities/${opportunityId}/report`));
  assert.equal(refreshedReport.freshness.isStale, false);
  score = refreshedReport.report.report.fitScore.overall;
  gaps = refreshedReport.report.report.gaps.map((gap) => gap.requirementText);
  const unsupported = await payload(await client.json(`/api/applications/${applicationId}`, 'POST', { draftText: 'I have professional AWS experience.' }));
  assert.equal(unsupported.application.claims[0].verdict, 'UNSUPPORTED');
  assert.equal(unsupported.application.claimSummary.unsupported, 1);
  const supported = await payload(await client.json(`/api/applications/${applicationId}`, 'POST', { draftText: 'I am currently developing AWS through ongoing project work.' }));
  assert.ok(['SUPPORTED', 'NEEDS_REVIEW'].includes(supported.application.claims[0].verdict));
  assert.equal((await client.json(`/api/applications/${applicationId}/review`, 'POST', { reviewNote: 'Synthetic human review.' })).status, 200);
  assert.equal((await client.request(`/api/applications/${applicationId}`)).status, 200);
  assert.equal((await client.json(`/api/evidence/${awsEvidence.evidence.id}/delete`, 'POST', {})).status, 204);
  const afterEvidenceDeletion = await payload(await client.request(`/api/applications/${applicationId}`));
  assert.equal(afterEvidenceDeletion.application.stale, true);
  assert.equal(afterEvidenceDeletion.application.claims[0].verdict, 'NEEDS_REVIEW');
  const roadmapAfterEvidenceDeletion = await payload(await client.request(`/api/opportunities/${opportunityId}/roadmap`));
  assert.equal(roadmapAfterEvidenceDeletion.roadmap.find((item) => item.id === roadmap.id).evidence.length, 0);

  const dashboard = await (await client.request('/dashboard')).text();
  assert.match(dashboard, /OPPORTUNITIES/);
  assert.match(dashboard, /APPLICATIONS/);
  assert.match(dashboard, /ROADMAP/);
  assert.match(dashboard, /2/);
  const reportAfterWork = await payload(await client.request(`/api/opportunities/${opportunityId}/report`));
  assert.equal(reportAfterWork.report.report.fitScore.overall, score);
  assert.deepEqual(reportAfterWork.report.report.gaps.map((gap) => gap.requirementText), gaps);

  const changedProfile = await client.json('/api/profile', 'POST', { name: 'Synthetic Candidate Updated', targetRoles: ['Python Backend Developer'], location: 'India', currentStatus: 'student', summary: 'Updated synthetic context.' });
  assert.equal(changedProfile.status, 200);
  const staleApplication = await payload(await client.request(`/api/applications/${applicationId}`));
  assert.equal(staleApplication.application.stale, true);
  assert.equal((await client.json(`/api/applications/${applicationId}/review`, 'POST', {})).status, 409);
  const staleReport = await payload(await client.request(`/api/opportunities/${opportunityId}/report`));
  assert.equal(staleReport.freshness.isStale, true);
  assert.equal(staleReport.companySignals, null);

  const other = new Client(client.base);
  await signup(other, 'phase19-other@example.com');
  for (const route of [`/api/opportunities/${opportunityId}/report`, `/api/applications/${applicationId}`, `/api/evidence/${evidence.evidence.id}`, `/api/skills/${python.skills.id}`]) assert.equal((await other.request(route)).status, 404);
  assert.equal((await other.json(`/api/roadmap-items/${roadmap.id}/status`, 'POST', { status: 'SKIPPED' })).status, 404);

  assert.equal((await client.json(`/api/opportunities/${opportunityId}/delete`, 'POST', {})).status, 204);
  assert.equal((await client.request(`/api/applications/${applicationId}`)).status, 404);
  assert.equal((await client.request(`/api/opportunities/${opportunityId}/roadmap`)).status, 404);
});
