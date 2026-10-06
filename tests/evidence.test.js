const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('../src/app');
const { AppDatabase } = require('../src/db');
const { hashPassword } = require('../src/security');

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

  async csrf() {
    const response = await this.request('/api/auth/csrf');
    return (await response.json()).csrfToken;
  }

  async json(route, method, value = {}, csrf) {
    return this.request(route, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': csrf || '' },
      body: JSON.stringify({ ...value, ...(csrf ? { csrf } : {}) }),
    });
  }
}

async function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'career-commander-evidence-'));
  const server = createApp({ dbPath: path.join(directory, 'test.sqlite'), nodeEnv: 'test' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}`, directory };
}

async function teardown(context) {
  await new Promise((resolve) => context.server.close(resolve));
  context.server.database.close();
  fs.rmSync(context.directory, { recursive: true, force: true });
}

async function signup(client, email) {
  const csrf = await client.csrf();
  const response = await client.json('/api/auth/signup', 'POST', { email, password: 'correct horse battery staple' }, csrf);
  assert.equal(response.status, 201);
  return response.json();
}

async function mutate(client, route, method, value = {}) {
  const csrf = await client.csrf();
  const response = await client.json(route, method, value, csrf);
  return { response, payload: response.status === 204 ? null : await response.json() };
}

async function seedRelated(client) {
  const skill = await mutate(client, '/api/skills', 'POST', { name: 'Django', status: 'VERIFIED', supportingReference: 'Built a backend service.' });
  const project = await mutate(client, '/api/projects', 'POST', { name: 'Career Commander', description: 'A structured career tool.' });
  const experience = await mutate(client, '/api/experience', 'POST', { organization: 'Independent', role: 'Engineer', description: 'Built the service.' });
  const education = await mutate(client, '/api/education', 'POST', { institution: 'University', program: 'Computer Science' });
  return {
    skillId: skill.payload.skills.id,
    projectId: project.payload.projects.id,
    experienceId: experience.payload.experience.id,
    educationId: education.payload.education.id,
  };
}

function evidenceValue(related = {}) {
  return {
    title: 'Deterministic scoring implementation',
    description: 'Implemented a server-side scoring workflow with traceable records.',
    evidenceType: 'PROJECT',
    status: 'VERIFIED',
    sourceType: 'REPOSITORY',
    sourceTitle: 'Career Commander repository',
    sourceReference: 'Repository README and implementation history',
    sourceUrl: 'https://example.com/repository',
    timeframeStart: '2025-01-01',
    timeframeEnd: '2025-06-01',
    notes: 'User-provided reference for later review.',
    ...related,
  };
}

test('evidence CRUD, provenance, explicit relationships, filtering, audit events, and UI work', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const client = new Client(context.base);
  await signup(client, 'evidence@example.com');
  const related = await seedRelated(client);
  const created = await mutate(client, '/api/evidence', 'POST', evidenceValue({
    skillIds: [related.skillId], projectIds: [related.projectId], experienceIds: [related.experienceId], educationIds: [related.educationId],
  }));
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.evidence.status, 'VERIFIED');
  assert.equal(created.payload.evidence.links.length, 4);
  const id = created.payload.evidence.id;
  const read = await client.request(`/api/evidence/${id}`);
  assert.equal((await read.json()).evidence.sourceType, 'REPOSITORY');
  const filtered = await client.request('/api/evidence?q=scoring&status=VERIFIED&type=PROJECT');
  assert.equal((await filtered.json()).evidence.length, 1);
  const updated = await mutate(client, `/api/evidence/${id}`, 'PATCH', evidenceValue({ status: 'LEARNING', skillIds: [related.skillId], projectIds: [related.projectId] }));
  assert.equal(updated.response.status, 200);
  assert.equal(updated.payload.evidence.status, 'LEARNING');
  assert.equal(updated.payload.evidence.links.length, 2);
  const page = await client.request('/evidence');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Deterministic scoring implementation/);
  const detail = await client.request(`/evidence/${id}`);
  assert.match(await detail.text(), /User-provided evidence/);
  const events = context.server.database.listAuditEventsForUser(context.server.database.getUserByEmail('evidence@example.com').id).map((event) => event.action);
  assert.ok(events.includes('evidence_created'));
  assert.ok(events.includes('evidence_updated'));
  assert.ok(events.includes('evidence_linked'));
  assert.ok(events.includes('evidence_unlinked'));
  assert.equal((await mutate(client, `/api/evidence/${id}`, 'DELETE')).response.status, 204);
  assert.equal((await client.request(`/api/evidence/${id}`)).status, 404);
  assert.ok(context.server.database.listAuditEventsForUser(context.server.database.getUserByEmail('evidence@example.com').id).some((event) => event.action === 'evidence_deleted'));
});

test('evidence preserves an honest empty state and protects anonymous access', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const anonymous = new Client(context.base);
  assert.equal((await anonymous.request('/evidence')).status, 302);
  assert.equal((await anonymous.request('/api/evidence')).status, 401);
  assert.equal((await anonymous.json('/api/evidence', 'POST', evidenceValue())).status, 401);
  assert.equal((await anonymous.json('/api/evidence/not-owned', 'PATCH', evidenceValue())).status, 401);
  assert.equal((await anonymous.json('/api/evidence/not-owned', 'DELETE')).status, 401);
  const client = new Client(context.base);
  await signup(client, 'empty-evidence@example.com');
  const page = await client.request('/evidence');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /No evidence yet/);
  assert.equal((await client.json('/api/evidence', 'POST', evidenceValue(), '')).status, 403);
});

test('evidence validation rejects unsafe, malformed, and oversized input', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const client = new Client(context.base);
  await signup(client, 'validation-evidence@example.com');
  for (const invalid of [
    { status: 'EXPERT' },
    { evidenceType: 'INFERRED' },
    { sourceUrl: 'javascript:alert(1)' },
    { sourceUrl: 'data:text/html,unsafe' },
    { description: 'x'.repeat(3001) },
    { timeframeStart: '2025-03-01', timeframeEnd: '2025-02-01' },
  ]) {
    const response = await mutate(client, '/api/evidence', 'POST', evidenceValue(invalid));
    assert.equal(response.response.status, 400);
  }
});

test('evidence links require owned records, deduplicate relationships, and survive related-record deletion', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const first = new Client(context.base);
  const firstUser = await signup(first, 'links-a@example.com');
  const firstRelated = await seedRelated(first);
  const second = new Client(context.base);
  await signup(second, 'links-b@example.com');
  const secondRelated = await seedRelated(second);
  const crossUser = await mutate(second, '/api/evidence', 'POST', evidenceValue({ skillIds: [firstRelated.skillId] }));
  assert.equal(crossUser.response.status, 400);
  const created = await mutate(first, '/api/evidence', 'POST', evidenceValue({ skillIds: [firstRelated.skillId, firstRelated.skillId], projectIds: [firstRelated.projectId] }));
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.evidence.links.length, 2);
  const id = created.payload.evidence.id;
  assert.equal((await second.request(`/api/evidence/${id}`)).status, 404);
  assert.equal((await mutate(second, `/api/evidence/${id}`, 'PATCH', evidenceValue({ status: 'LEARNING' }))).response.status, 404);
  assert.equal((await mutate(second, `/api/evidence/${id}`, 'DELETE')).response.status, 404);
  assert.equal((await mutate(first, `/api/projects/${firstRelated.projectId}/delete`, 'POST')).response.status, 204);
  const afterProjectDelete = await first.request(`/api/evidence/${id}`);
  const remainingLinks = (await afterProjectDelete.json()).evidence.links;
  assert.equal(remainingLinks.length, 1);
  assert.equal(remainingLinks[0].entityType, 'skill');
  assert.equal(firstUser.user.email, 'links-a@example.com');
  assert.notEqual(secondRelated.skillId, firstRelated.skillId);
});

test('evidence detail safely escapes user content and supports all explicit relationship types', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const client = new Client(context.base);
  await signup(client, 'escape-evidence@example.com');
  const related = await seedRelated(client);
  const created = await mutate(client, '/api/evidence', 'POST', evidenceValue({ title: '<script>alert(1)</script>', description: '<img src=x onerror=alert(1)>', skillIds: [related.skillId], projectIds: [related.projectId], experienceIds: [related.experienceId], educationIds: [related.educationId] }));
  const page = await client.request(`/evidence/${created.payload.evidence.id}`);
  const html = await page.text();
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x onerror=alert/);
  assert.match(html, /Career Commander repository/);
});

test('existing Phase 3 data remains available when the Evidence Locker schema is introduced', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'career-commander-migration-'));
  const dbPath = path.join(directory, 'migration.sqlite');
  const first = new AppDatabase(dbPath);
  const user = first.createUser({ email: 'migration@example.com', passwordHash: hashPassword('correct horse battery staple') });
  first.updateProfileForUser(user.id, { name: 'Migration Candidate', targetRoles: ['Engineer'], location: '', currentStatus: '', summary: '' });
  first.createEducation(user.id, { institution: 'University', program: 'Computer Science', field: 'Systems', startDate: '', endDate: '', description: 'Existing education' });
  first.createSkill(user.id, { name: 'Node.js', status: 'VERIFIED', supportingReference: 'Existing skill reference', description: '' });
  first.createProject(user.id, { name: 'Existing project', description: 'Existing project data', technologies: ['Node.js'], roleContribution: '', timeframeStart: '', timeframeEnd: '', repositoryUrl: '', demoUrl: '', outcome: '', associatedEvidence: 'Existing project reference' });
  first.createExperience(user.id, { organization: 'Existing Org', role: 'Engineer', description: 'Existing experience data', startDate: '', endDate: '', responsibilities: ['Built systems'], technologies: ['Node.js'], evidenceReference: 'Existing experience reference' });
  first.close();
  const second = new AppDatabase(dbPath);
  assert.equal(second.getProfileForUser(user.id).name, 'Migration Candidate');
  assert.equal(second.listSkillsForUser(user.id)[0].supporting_reference, 'Existing skill reference');
  assert.equal(second.listProjectsForUser(user.id)[0].associated_evidence, 'Existing project reference');
  assert.equal(second.listExperienceForUser(user.id)[0].evidence_reference, 'Existing experience reference');
  assert.equal(second.listEducationForUser(user.id)[0].program, 'Computer Science');
  assert.deepEqual(second.listEvidenceForUser(user.id), []);
  second.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
