const assert = require('node:assert/strict');
const test = require('node:test');
const { applicationFreshness, groundClaims, applicationSourceSnapshot } = require('../src/application');

function context() {
  return {
    opportunity: { contentHash: 'job-1' },
    requirements: { id: 'req-1', contentHash: 'req-hash' },
    matchRun: { id: 'match-1' },
    score: { id: 'score-1' },
    gapRun: { id: 'gap-run-1' },
    candidateContextFingerprint: 'candidate-1',
    profile: { summary: 'Backend engineer.' },
    skills: [{ id: 'python', name: 'Python', status: 'VERIFIED' }, { id: 'aws', name: 'AWS', status: 'LEARNING' }],
    projects: [{ id: 'project-1', name: 'API service' }],
    evidence: [{ id: 'evidence-1', title: 'API repository', status: 'VERIFIED', links: [{ entityType: 'skill', entityId: 'python' }] }],
    gaps: [{ id: 'gap-1', requirementText: 'AWS' }],
  };
}

test('Phase 18 claim checks distinguish supported, unsupported, and needs-review claims', () => {
  const claims = groundClaims('I built Python services.\n\nI have professional AWS experience.\n\nI collaborate across teams.', context());
  assert.equal(claims[0].verdict, 'SUPPORTED');
  assert.equal(claims[0].evidence[0].id, 'evidence-1');
  assert.equal(claims[1].verdict, 'UNSUPPORTED');
  assert.equal(claims[2].verdict, 'NEEDS_REVIEW');
});

test('Phase 18 application source snapshots become stale when deterministic inputs change', () => {
  const source = applicationSourceSnapshot(context());
  const application = { sourceSnapshot: source, stale: false, staleReason: '' };
  assert.equal(applicationFreshness(application, context()).isStale, false);
  const changed = context();
  changed.candidateContextFingerprint = 'candidate-2';
  const freshness = applicationFreshness(application, changed);
  assert.equal(freshness.isStale, true);
  assert.ok(freshness.reasons.includes('candidateContextFingerprint'));
});
