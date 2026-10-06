const assert = require('node:assert/strict');
const test = require('node:test');
const { createOmniRouteFromEnv } = require('../src/omniRoute');

test('LIVE OmniRoute search and chat contract', { skip: process.env.RUN_LIVE_OMNIROUTE !== '1' ? 'Set RUN_LIVE_OMNIROUTE=1 to run against the configured local OmniRoute instance.' : false }, async () => {
  const client = createOmniRouteFromEnv();
  const search = await client.search({ queries: ['Python Django AWS jobs'], profile: { targetRoles: ['Python developer'], location: '' } });
  assert.ok(Array.isArray(search.results));
  const analysis = await client.analyze({ system: 'Return JSON only.', user: '<JOB_POSTING_DATA>Python and Django</JOB_POSTING_DATA>' });
  assert.equal(typeof analysis.output, 'object');
});
