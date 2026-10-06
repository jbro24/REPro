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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'career-commander-profile-'));
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

test('profile can be created, read, updated, validated, and persisted', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const client = new Client(context.base);
  await signup(client, 'profile@example.com');
  const created = await mutate(client, '/api/profile', 'PUT', { name: 'Ada Lovelace', targetRoles: ['Software Engineer'], location: 'London', currentStatus: 'seeking', summary: 'Building reliable systems.' });
  assert.equal(created.response.status, 200);
  assert.equal(created.payload.profile.name, 'Ada Lovelace');
  assert.deepEqual(created.payload.profile.targetRoles, ['Software Engineer']);
  assert.equal(created.payload.profile.completionState, 'in_progress');
  const read = await client.request('/api/profile');
  assert.equal((await read.json()).profile.summary, 'Building reliable systems.');
  const invalidStatus = await mutate(client, '/api/profile', 'PUT', { name: 'Ada', currentStatus: 'invented_status' });
  assert.equal(invalidStatus.response.status, 400);
  const missingName = await mutate(client, '/api/profile', 'PUT', { summary: 'No name' });
  assert.equal(missingName.response.status, 400);
  const page = await client.request('/career-profile');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Ada Lovelace/);
});

test('server-rendered signup and onboarding forms preserve the progressive flow', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const client = new Client(context.base);
  const signupPage = await client.request('/signup');
  const signupHtml = await signupPage.text();
  const csrf = signupHtml.match(/name="csrf" value="([^"]+)"/)[1];
  const signupResponse = await client.request('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
    body: new URLSearchParams({ csrf, email: 'forms@example.com', password: 'correct horse battery staple' }),
  });
  assert.equal(signupResponse.status, 302);
  assert.equal(signupResponse.headers.get('location'), '/onboarding');
  assert.equal((await client.request('/onboarding')).status, 302);
  const onboarding = await client.request('/onboarding/welcome');
  assert.match(await onboarding.text(), /Welcome/);
  const onboardingHtml = await (await client.request('/onboarding/profile')).text();
  const onboardingCsrf = onboardingHtml.match(/name="csrf" value="([^"]+)"/)[1];
  const profileResponse = await client.request('/api/profile', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
    body: new URLSearchParams({ csrf: onboardingCsrf, name: 'Form Candidate', targetRoles: 'Engineer', next: '/onboarding/skills' }),
  });
  assert.equal(profileResponse.status, 302);
  assert.equal(profileResponse.headers.get('location'), '/onboarding/skills');
  assert.equal((await (await client.request('/api/onboarding')).json()).onboarding.step, 'skills');
});

test('education supports create/update and remains user-owned', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const first = new Client(context.base);
  await signup(first, 'education-a@example.com');
  const created = await mutate(first, '/api/education', 'POST', { institution: 'University', program: 'BSc', field: 'Computer Science', startDate: '2020-09-01', endDate: '2024-06-30', description: 'Formal study.' });
  assert.equal(created.response.status, 201);
  const id = created.payload.education.id;
  const updated = await mutate(first, `/api/education/${id}`, 'PATCH', { institution: 'University', program: 'BSc', field: 'Computer Science', startDate: '2020-09-01', endDate: '2024-06-30', description: 'Updated context.' });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.payload.education.description, 'Updated context.');
  const second = new Client(context.base);
  await signup(second, 'education-b@example.com');
  assert.equal((await second.request(`/api/education/${id}`)).status, 404);
  const crossUpdate = await mutate(second, `/api/education/${id}`, 'PATCH', { institution: 'Other', program: 'Other' });
  assert.equal(crossUpdate.response.status, 404);
  const invalidDates = await mutate(first, '/api/education', 'POST', { institution: 'U', program: 'P', startDate: '2025-01-01', endDate: '2024-01-01' });
  assert.equal(invalidDates.response.status, 400);
});

test('skills enforce explicit states and do not promote names to verified evidence', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const client = new Client(context.base);
  await signup(client, 'skills@example.com');
  const learning = await mutate(client, '/api/skills', 'POST', { name: 'AWS', status: 'LEARNING' });
  assert.equal(learning.response.status, 201);
  assert.equal(learning.payload.skills.status, 'LEARNING');
  const noEvidence = await mutate(client, '/api/skills', 'POST', { name: 'TypeScript', status: 'NO_EVIDENCE' });
  assert.equal(noEvidence.response.status, 201);
  const missingReference = await mutate(client, '/api/skills', 'POST', { name: 'Django', status: 'VERIFIED' });
  assert.equal(missingReference.response.status, 400);
  const verified = await mutate(client, '/api/skills', 'POST', { name: 'Python', status: 'VERIFIED', supportingReference: 'Built and maintained the reporting service.' });
  assert.equal(verified.response.status, 201);
  const invalidStatus = await mutate(client, '/api/skills', 'POST', { name: 'Go', status: 'EXPERT' });
  assert.equal(invalidStatus.response.status, 400);
  const duplicate = await mutate(client, '/api/skills', 'POST', { name: 'python', status: 'LEARNING' });
  assert.equal(duplicate.response.status, 400);
});

test('projects enforce URL validation and remain user-owned', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const first = new Client(context.base);
  await signup(first, 'projects-a@example.com');
  const invalid = await mutate(first, '/api/projects', 'POST', { name: 'Project', description: 'A real project.', repositoryUrl: 'javascript:alert(1)' });
  assert.equal(invalid.response.status, 400);
  const created = await mutate(first, '/api/projects', 'POST', { name: 'Career tool', description: 'A real project.', technologies: ['Node.js', 'SQLite'], roleContribution: 'Built the API', timeframeStart: '2024-01-01', timeframeEnd: '2024-05-01', repositoryUrl: 'https://github.com/example/project', outcome: 'Reduced manual work.', associatedEvidence: 'Repository and release notes.' });
  assert.equal(created.response.status, 201);
  const id = created.payload.projects.id;
  const updated = await mutate(first, `/api/projects/${id}`, 'PATCH', { name: 'Career tool v2', description: 'Updated project.', technologies: ['Node.js'], demoUrl: 'https://example.com/demo' });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.payload.projects.name, 'Career tool v2');
  const second = new Client(context.base);
  await signup(second, 'projects-b@example.com');
  assert.equal((await second.request(`/api/projects/${id}`)).status, 404);
  assert.equal((await mutate(second, `/api/projects/${id}/delete`, 'POST')).response.status, 404);
});

test('experience supports create/update and ownership filtering', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const first = new Client(context.base);
  await signup(first, 'experience-a@example.com');
  const created = await mutate(first, '/api/experience', 'POST', { organization: 'Independent', role: 'Engineer', description: 'Built a service.', startDate: '2023-01-01', responsibilities: ['Designed API'], technologies: ['Node.js'], evidenceReference: 'Repository link and release notes.' });
  assert.equal(created.response.status, 201);
  const id = created.payload.experience.id;
  const updated = await mutate(first, `/api/experience/${id}`, 'PATCH', { organization: 'Independent', role: 'Senior Engineer', description: 'Built and reviewed a service.', responsibilities: ['Designed API', 'Reviewed changes'], technologies: ['Node.js'] });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.payload.experience.role, 'Senior Engineer');
  const second = new Client(context.base);
  await signup(second, 'experience-b@example.com');
  assert.equal((await second.request(`/api/experience/${id}`)).status, 404);
});

test('onboarding state persists through partial completion, skip, resume, and completion', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const client = new Client(context.base);
  await signup(client, 'onboarding@example.com');
  let state = await client.request('/api/onboarding');
  assert.deepEqual((await state.json()).onboarding, { step: 'welcome', completed: false, completionState: 'not_started' });
  const profile = await mutate(client, '/api/profile', 'PUT', { name: 'Grace Hopper', targetRoles: ['Platform Engineer'], next: '/onboarding/skills' });
  assert.equal(profile.response.status, 200);
  state = await client.request('/api/onboarding');
  assert.equal((await state.json()).onboarding.step, 'skills');
  const skipProjects = await mutate(client, '/api/onboarding', 'POST', { step: 'projects' });
  assert.equal(skipProjects.response.status, 200);
  const resumed = new Client(context.base);
  const csrf = await resumed.csrf();
  await resumed.json('/api/auth/login', 'POST', { email: 'onboarding@example.com', password: 'correct horse battery staple' }, csrf);
  state = await resumed.request('/api/onboarding');
  assert.equal((await state.json()).onboarding.step, 'projects');
  const skipExperience = await mutate(resumed, '/api/onboarding', 'POST', { step: 'experience' });
  assert.equal(skipExperience.response.status, 200);
  const skipEvidence = await mutate(resumed, '/api/onboarding', 'POST', { step: 'evidence' });
  assert.equal(skipEvidence.response.status, 200);
  const complete = await mutate(resumed, '/api/onboarding', 'POST', { step: 'complete' });
  assert.equal(complete.response.status, 200);
  assert.equal(complete.payload.onboarding.completed, true);
  assert.equal((await resumed.request('/dashboard')).status, 200);
  assert.match(await (await resumed.request('/dashboard')).text(), /Your evidence base is ready/);
});

test('unauthorized mutations are rejected and user-provided HTML is escaped', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const anonymous = new Client(context.base);
  const csrf = await anonymous.csrf();
  assert.equal((await anonymous.json('/api/profile', 'PUT', { name: 'No access' }, csrf)).status, 401);
  const client = new Client(context.base);
  await signup(client, 'xss@example.com');
  const profile = await mutate(client, '/api/profile', 'PUT', { name: 'Candidate', summary: '<script>alert(1)</script>' });
  assert.equal(profile.response.status, 200);
  const page = await client.request('/career-profile');
  const html = await page.text();
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});

test('all phase 3 collections are isolated from another authenticated user', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const first = new Client(context.base);
  await signup(first, 'isolation-a@example.com');
  const records = {};
  records.education = (await mutate(first, '/api/education', 'POST', { institution: 'U', program: 'P' })).payload.education.id;
  records.skills = (await mutate(first, '/api/skills', 'POST', { name: 'Python', status: 'NO_EVIDENCE' })).payload.skills.id;
  records.projects = (await mutate(first, '/api/projects', 'POST', { name: 'P', description: 'D' })).payload.projects.id;
  records.experience = (await mutate(first, '/api/experience', 'POST', { organization: 'O', role: 'R' })).payload.experience.id;
  const second = new Client(context.base);
  await signup(second, 'isolation-b@example.com');
  for (const [collection, id] of Object.entries(records)) {
    assert.equal((await second.request(`/api/${collection}/${id}`)).status, 404, collection);
    assert.equal((await mutate(second, `/api/${collection}/${id}`, 'PATCH', {})).response.status, 404, `${collection} cross-user update should be hidden`);
  }
});
