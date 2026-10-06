const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('../src/app');
const { hashToken, hashPassword, randomToken } = require('../src/security');

class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
  }

  updateCookies(response) {
    const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    for (const value of setCookies) {
      const [pair] = value.split(';');
      const separator = pair.indexOf('=');
      if (separator === -1) continue;
      const name = pair.slice(0, separator);
      const cookieValue = pair.slice(separator + 1);
      if (!cookieValue || /Max-Age=0/.test(value)) this.cookies.delete(name);
      else this.cookies.set(name, decodeURIComponent(cookieValue));
    }
  }

  async request(pathname, options = {}) {
    const headers = new Headers(options.headers || {});
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; '));
    const response = await fetch(`${this.base}${pathname}`, { ...options, headers, redirect: 'manual' });
    this.updateCookies(response);
    return response;
  }

  async csrf() {
    const response = await this.request('/api/auth/csrf');
    return (await response.json()).csrfToken;
  }

  async json(pathname, method, body, csrf) {
    return this.request(pathname, {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-csrf-token': csrf || '',
      },
      body: JSON.stringify({ ...body, ...(csrf ? { csrf } : {}) }),
    });
  }
}

async function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'career-commander-'));
  const server = createApp({ dbPath: path.join(directory, 'test.sqlite'), nodeEnv: 'test' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  return { server, base, directory };
}

async function teardown({ server, directory }) {
  await new Promise((resolve) => server.close(resolve));
  server.database.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

async function signup(client, email, password = 'correct horse battery staple') {
  const csrf = await client.csrf();
  const response = await client.json('/api/auth/signup', 'POST', { email, password }, csrf);
  return { response, csrf };
}

test('signup creates an account and authenticated session', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const client = new Client(context.base);
  const { response } = await signup(client, 'one@example.com');
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.user.email, 'one@example.com');
  assert.ok(payload.profileId);
  assert.equal((await client.request('/api/auth/me')).status, 200);
  assert.equal(context.server.database.countUsers(), 1);
});

test('duplicate account does not create a second user or disclose account details', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const first = new Client(context.base);
  await signup(first, 'same@example.com');
  const second = new Client(context.base);
  const { response } = await signup(second, 'SAME@example.com');
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Unable to create account/);
  assert.equal(context.server.database.countUsers(), 1);
});

test('valid login creates a rotated authenticated session', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const creator = new Client(context.base);
  await signup(creator, 'login@example.com');
  const client = new Client(context.base);
  const csrf = await client.csrf();
  const response = await client.json('/api/auth/login', 'POST', { email: 'login@example.com', password: 'correct horse battery staple' }, csrf);
  assert.equal(response.status, 200);
  assert.equal((await client.request('/api/auth/me')).status, 200);
});

test('invalid login returns a generic error', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const creator = new Client(context.base);
  await signup(creator, 'invalid@example.com');
  const client = new Client(context.base);
  const csrf = await client.csrf();
  const response = await client.json('/api/auth/login', 'POST', { email: 'invalid@example.com', password: 'wrong password here' }, csrf);
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.error, 'Invalid email or password.');
});

test('logout revokes the authenticated session', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const client = new Client(context.base);
  await signup(client, 'logout@example.com');
  const csrf = await client.csrf();
  const response = await client.json('/api/auth/logout', 'POST', {}, csrf);
  assert.equal(response.status, 204);
  assert.equal((await client.request('/api/auth/me')).status, 401);
});

test('protected pages and APIs reject anonymous requests', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const client = new Client(context.base);
  for (const route of ['/dashboard', '/opportunities', '/career-profile', '/evidence', '/analysis', '/applications', '/discovery', '/settings']) {
    const page = await client.request(route);
    assert.equal(page.status, 302, route);
    assert.match(page.headers.get('location'), /^\/login/, route);
  }
  assert.equal((await client.request('/api/profile')).status, 401);
});

test('state-changing requests require a valid CSRF token', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const client = new Client(context.base);
  await signup(client, 'csrf@example.com');
  const response = await client.json('/api/auth/logout', 'POST', {}, 'incorrect-token');
  assert.equal(response.status, 403);
  assert.equal((await client.request('/api/auth/me')).status, 200);
});

test('account password change rotates the current session and invalidates the old password', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const client = new Client(context.base);
  await signup(client, 'settings@example.com');
  const csrf = await client.csrf();
  const changed = await client.json('/api/settings/password', 'POST', {
    currentPassword: 'correct horse battery staple',
    newPassword: 'a different secure phrase',
  }, csrf);
  assert.equal(changed.status, 200);
  assert.equal((await client.request('/api/auth/me')).status, 200);
  const oldLogin = new Client(context.base);
  const oldCsrf = await oldLogin.csrf();
  assert.equal((await oldLogin.json('/api/auth/login', 'POST', { email: 'settings@example.com', password: 'correct horse battery staple' }, oldCsrf)).status, 401);
});

test('cross-user profile access is denied by server-side ownership filtering', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const first = new Client(context.base);
  const firstSignup = await signup(first, 'first@example.com');
  const firstPayload = await firstSignup.response.json();
  const second = new Client(context.base);
  await signup(second, 'second@example.com');
  assert.equal((await second.request(`/api/profiles/${firstPayload.profileId}`)).status, 404);
  assert.equal((await first.request(`/api/profiles/${firstPayload.profileId}`)).status, 200);
});

test('password reset is one-time, expires sessions, and accepts the new password', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const existing = new Client(context.base);
  await signup(existing, 'reset@example.com');
  const requestClient = new Client(context.base);
  const requestCsrf = await requestClient.csrf();
  const requested = await requestClient.json('/api/auth/password-reset/request', 'POST', { email: 'reset@example.com' }, requestCsrf);
  assert.equal(requested.status, 200);
  const { resetToken } = await requested.json();
  assert.ok(resetToken);
  const confirmCsrf = await requestClient.csrf();
  const confirmed = await requestClient.json('/api/auth/password-reset/confirm', 'POST', { token: resetToken, password: 'new correct battery phrase' }, confirmCsrf);
  assert.equal(confirmed.status, 200);
  const replayCsrf = await requestClient.csrf();
  const replay = await requestClient.json('/api/auth/password-reset/confirm', 'POST', { token: resetToken, password: 'another correct phrase' }, replayCsrf);
  assert.equal(replay.status, 400);
  const oldLogin = new Client(context.base);
  const oldCsrf = await oldLogin.csrf();
  assert.equal((await oldLogin.json('/api/auth/login', 'POST', { email: 'reset@example.com', password: 'correct horse battery staple' }, oldCsrf)).status, 401);
  const newLogin = new Client(context.base);
  const newCsrf = await newLogin.csrf();
  assert.equal((await newLogin.json('/api/auth/login', 'POST', { email: 'reset@example.com', password: 'new correct battery phrase' }, newCsrf)).status, 200);
  assert.equal((await existing.request('/api/auth/me')).status, 401);
});

test('invalid and expired session tokens cannot access protected data', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const creator = new Client(context.base);
  const { response } = await signup(creator, 'expired@example.com');
  const payload = await response.json();
  const user = context.server.database.getUserByEmail('expired@example.com');
  context.server.database.createSession({ userId: user.id, tokenHash: hashToken('expired-token'), csrfToken: randomToken(24), expiresAt: new Date(Date.now() - 1000).toISOString() });
  const expired = new Client(context.base);
  expired.cookies.set('cc_session', 'expired-token');
  assert.equal((await expired.request('/api/profiles/' + payload.profileId)).status, 401);
  const invalid = new Client(context.base);
  invalid.cookies.set('cc_session', 'not-a-real-session');
  assert.equal((await invalid.request('/api/auth/me')).status, 401);
});

test('password hashing is salted and does not store plaintext', () => {
  const context = require('../src/security');
  const first = context.hashPassword('a secure test password');
  const second = context.hashPassword('a secure test password');
  assert.notEqual(first, second);
  assert.equal(context.verifyPassword('a secure test password', first), true);
  assert.equal(context.verifyPassword('wrong password', first), false);
  assert.equal(first.includes('a secure test password'), false);
});
