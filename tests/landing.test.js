const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('../src/app');

async function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'career-commander-landing-'));
  const server = createApp({ dbPath: path.join(directory, 'test.sqlite'), nodeEnv: 'test' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}`, directory };
}

async function teardown(context) {
  await new Promise((resolve) => context.server.close(resolve));
  context.server.database.close();
  fs.rmSync(context.directory, { recursive: true, force: true });
}

test('public landing page communicates the evidence-first product model', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  const response = await fetch(`${context.base}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Your career\.<br>Backed by evidence\./);
  assert.match(html, /Career Commander turns job descriptions/);
  assert.match(html, /AI helps interpret and draft/);
  assert.match(html, /Deterministic scoring/);
  assert.match(html, /Claim verification/);
  assert.match(html, /Ready for human review/);
  assert.match(html, /class="landing-tree"/);
  assert.equal((html.match(/class="landing-petal"/g) || []).length, 12);
  assert.match(html, /href="\/signup"/);
  assert.match(html, /href="#how-it-works"/);
  assert.doesNotMatch(html, /Unlock your future|AI-powered everything|Expert-level/);
});

test('landing and authentication smoke routes remain available while protected routes stay protected', async (t) => {
  const context = await setup();
  t.after(() => teardown(context));
  for (const route of ['/', '/login', '/signup', '/password-reset', '/app.js']) {
    assert.equal((await fetch(`${context.base}${route}`)).status, 200, route);
  }
  assert.equal((await fetch(`${context.base}/dashboard`, { redirect: 'manual' })).status, 302);
  assert.equal((await fetch(`${context.base}/evidence`, { redirect: 'manual' })).status, 302);
  const styles = await (await fetch(`${context.base}/styles.css`)).text();
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(styles, /landing-petal-fall/);
});
