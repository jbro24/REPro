const ROADMAP_VERSION = 'roadmap-v1';
const ROADMAP_STATUSES = Object.freeze(['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED']);

function subjectKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function workForSubject(subject, gapState) {
  const key = subjectKey(subject);
  const partialNote = gapState === 'PARTIAL' ? ' Extend the current learning work into a reviewable artifact.' : '';
  if (key.includes('aws')) return {
    task: `Deploy an existing Django/PostgreSQL project to AWS and document the deployment.${partialNote}`,
    potentialEvidence: 'Deployment configuration, architecture notes, deployment logs or screenshots, and a repository document explaining what was implemented.',
  };
  if (key.includes('docker')) return {
    task: `Containerize an existing backend project with Docker and document how to build and run it.${partialNote}`,
    potentialEvidence: 'Dockerfile, compose configuration, repository changes, and reproducible run documentation.',
  };
  if (key.includes('postgres')) return {
    task: `Add a PostgreSQL-backed feature to an existing project and document the schema and queries.${partialNote}`,
    potentialEvidence: 'Repository implementation, migration/schema files, query examples, and a short implementation note.',
  };
  if (key.includes('typescript')) return {
    task: `Add a small typed TypeScript feature to an existing project and document the interfaces and test results.${partialNote}`,
    potentialEvidence: 'TypeScript source, type definitions, tests, and a repository note describing the implementation.',
  };
  if (key.includes('python')) return {
    task: `Build a focused Python feature in an existing project, add tests, and document the implementation.${partialNote}`,
    potentialEvidence: 'Repository code, automated tests, and a concise implementation document tied to the requirement.',
  };
  return {
    task: `Build a small, reviewable artifact that demonstrates ${subject}, then document the result.${partialNote}`,
    potentialEvidence: `A repository, deployment, or work record showing ${subject}, with a short explanation of what was done.`,
  };
}

function roadmapForGaps(gaps = []) {
  return [...gaps].sort((a, b) => (a.priority === 'REQUIRED' ? 0 : 1) - (b.priority === 'REQUIRED' ? 0 : 1)).map((gap) => {
    const subject = gap.requirementText;
    const work = workForSubject(subject, gap.gapState);
    return {
      requirementId: gap.requirementId,
      priority: gap.priority,
      gapState: gap.gapState,
      requirementText: subject,
      task: work.task,
      potentialEvidence: work.potentialEvidence,
      status: 'PLANNED',
      logicVersion: ROADMAP_VERSION,
    };
  });
}

module.exports = { ROADMAP_STATUSES, ROADMAP_VERSION, roadmapForGaps, workForSubject };
