# Career Commander pipeline boundaries

Batch 2 keeps the career-intelligence workflow as explicit, inspectable stages:

```text
Profile
  -> Discovery (Manual / Web / Email)
  -> Opportunity
  -> JobRequirements
  -> MatchRun / MatchResults
  -> ScoreBreakdown
  -> GapRun / Gaps
  -> CompanySignals / ProjectRelevance / RoadmapItems
  -> OpportunityReport
```

## Opportunity

`src/opportunity.js` validates the canonical intake payload, preserves the raw job
description, creates normalized comparison fields, and derives a deterministic
deduplication key. `opportunity_provenance` preserves each source that contributed
the same opportunity. Manual, Web, and Email all use this same payload and store.
Discovery runs record actual provider results, duplicates, rejected results, failures,
and automatic analysis counts.

`src/discovery.js` builds profile-driven search queries and validates provider results.
Search and mailbox providers are injected into `createApp`; OmniRoute, Gmail, Outlook,
and mock adapters can be supplied without coupling the domain model to any provider.
No provider result is fabricated when a boundary is unavailable.

## Job Analyst

`src/jobAnalyst.js` is the only model-provider boundary. It receives raw job text
inside an explicit untrusted-data delimiter and returns a validated
`job-requirements-v1` object. It cannot produce candidate fit, evidence status, a
score, or an application decision. The provider is injected into `createApp` so
tests use deterministic mocks and production can supply a provider later.

## Matcher

`src/matcher.js` uses explicit skill declarations and explicit evidence links. A
VERIFIED skill is a MATCH only when it also has linked VERIFIED evidence. LEARNING
is PARTIAL, and absence of supporting evidence is MISSING. The matcher returns
facts and explanations only; it does not calculate a score.

## Scorer

`src/scoring.js` is pure deterministic code. Required results contribute 70% and
preferred results contribute 30%. Only MATCH counts toward either percentage;
PARTIAL and MISSING remain visible in the breakdown. Empty groups have explicit
behavior and both groups empty produces a score of zero.

## Gap analyzer

`src/gaps.js` consumes MatchResults rather than reparsing job prose. PARTIAL and
MISSING results become evidence-grounded gaps. MATCH results do not create gaps.
`gap_runs` records that analysis was completed even when the result contains zero
gap rows, which keeps the UI and API reproducible for all-match cases.

## Automatic analysis and reports

`src/pipeline.js` runs the existing analyst, matcher, scorer, and gap analyzer in order
for new manual, Web, and Email opportunities. Each stage is persisted before the next
stage begins. A later failure leaves earlier successful stages intact and records an
honest retryable analysis state on the Opportunity.

`src/agents.js` contains the enrichment boundaries. Company signals are labelled
`OBSERVED` or `INFERRED`; project relevance is grounded in the owned project records;
and `src/roadmap.js` turns explicit gaps into suggested evidence-producing work.
`src/report.js` combines these structured facts into one Opportunity report without
changing match states, scores, or gaps.

Every pipeline table includes the authenticated user scope, explicit version
fields, and foreign-key relationships. Application queries resolve all records by
the authenticated principal; request bodies and paths never supply trusted
ownership.
