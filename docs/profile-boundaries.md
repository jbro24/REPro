# Phase 3 profile and evidence boundaries

## Profile information is not evidence

Career Profile fields describe candidate context: name, target roles, location, status,
summary, education, skills, projects, and experience. They are user-owned declarations.

The system does not infer verified claims from these declarations. A technology listed on a
project or experience record is not automatically verified, and a degree does not imply
technology experience.

Skills therefore require an explicit state:

- `VERIFIED` requires a supporting reference and is still a candidate-provided state until
  a later evidence workflow validates it.
- `LEARNING` explicitly means the candidate is developing the skill.
- `NO_EVIDENCE` means the skill is known as a declaration but currently has no supporting
  evidence in Career Commander.

## Future evidence association

The `evidence_links` table is the single relationship model used by the Evidence Locker. It
stores the authenticated owner, evidence ID, entity type, and entity ID for skills, projects,
experience, and education. Relationships are explicitly selected by the user, deduplicated by
the database, and checked against the authenticated owner's records before they are written.
Deleting a profile entity removes only its relationship rows; the evidence record remains so
its provenance is not silently destroyed.

Phase 3 supporting-reference fields (`supporting_reference`, `associated_evidence`, and
`evidence_reference`) remain intact. They are legacy profile-side references and are not
silently converted into structured Evidence records. A user can create structured evidence
and link it explicitly without losing the original text.

Evidence has structured title, description, type, source, URL, timeframe, notes, and
capability-context fields. `VERIFIED`, `LEARNING`, and `NO_EVIDENCE` describe the candidate's
explicit context; they do not claim independent source verification. URLs are limited to
HTTP/HTTPS and are rendered as escaped user-provided references.

## Ownership

All Phase 3 reads, updates, and deletes use `user_id` from the authenticated session. A
request body, hidden form field, query parameter, or URL path can identify a record, but it
cannot identify its owner. Cross-user records return `404` to avoid resource enumeration.

## Onboarding state

Onboarding state is stored on the user's single profile row. The state is one of:

`welcome → profile → skills → projects → experience → evidence → complete`

Optional sections may be skipped. Completion still requires a profile name. No fit score or
job-readiness percentage is calculated during onboarding.
