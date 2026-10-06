# Career Commander

Career Commander is an evidence-first career intelligence command center. The authenticated
workflow is organized around Profile, Discover, Opportunities, Applications, and Settings.
Manual, Web, and Email intake converge into one owned Opportunity pipeline. New discovered
opportunities can automatically run Job Analyst, deterministic matching, deterministic scoring,
gap analysis, enrichment, and report generation.

## Run locally

Requires Node.js 22.14 or newer because the project uses Node's built-in SQLite support.

```powershell
npm test
npm start
```

The server runs at `http://127.0.0.1:3000` and stores the local database at `data/career-commander.sqlite`. Set `CC_DATABASE_PATH` to use another database file.

## Authentication routes

Public pages:

- `/`
- `/login`
- `/signup`
- `/password-reset`

Protected pages:

- `/dashboard`
- `/profile`
- `/discover`
- `/opportunities`
- `/applications`
- `/settings`

The legacy `/career-profile` and `/discovery` routes remain compatible aliases. Evidence
remains available from the Profile workflow at `/evidence`; analysis is embedded in an
Opportunity report rather than exposed as a primary navigation destination.

JSON authentication APIs are under `/api/auth`. Authenticated account APIs are under `/api/settings` and `/api/profile`.

Discovery APIs are under `/api/discover`: manual intake, profile-driven Web scanning,
mailbox configuration, Email scanning, and `/api/discovery/runs`. Provider boundaries are
injected into `createApp`; no live Web or mailbox data is fabricated when a provider is absent.

## OmniRoute adapter

The normal server entry point wires the existing provider boundaries to `src/omniRoute.js`.
Configuration is environment-driven:

- `OMNIROUTE_BASE_URL` (default `http://localhost:20128/v1`)
- `OMNIROUTE_API_KEY` (optional; never logged)
- `OMNIROUTE_MODEL` (optional)
- `OMNIROUTE_TIMEOUT_MS` (default `20000`)
- `OMNIROUTE_MAX_RETRIES` (default `1`)
- `OMNIROUTE_SEARCH_LIMIT` (default `8`, capped at `10`)

Live external tests are opt-in with `RUN_LIVE_OMNIROUTE=1`; normal tests use isolated
provider-contract fakes and do not require OmniRoute to be running.

## Profile and onboarding APIs

- `GET|POST|PUT /api/profile`
- `GET|POST|PATCH|DELETE /api/education`
- `GET|POST|PATCH|DELETE /api/skills`
- `GET|POST|PATCH|DELETE /api/projects`
- `GET|POST|PATCH|DELETE /api/experience`
- `GET|POST|PATCH /api/onboarding`
- `GET|POST|PATCH|PUT|DELETE /api/evidence`

Evidence detail routes are available at `/evidence`, `/evidence/new`, and
`/evidence/:id`. Evidence is separate from profile declarations, uses explicit provenance,
and can be linked to owned skills, projects, experience, and education through the single
`evidence_links` relationship table. A capability context is user-provided; adding a source
does not automatically change a skill state or independently verify a reference.

Every record is created and queried through the authenticated session principal. The API
does not accept a client-supplied user ID. Skills have explicit `VERIFIED`, `LEARNING`, and
`NO_EVIDENCE` states; `VERIFIED` requires a supporting reference.

## Local password reset

There is no email provider in the repository yet. In development and tests, the reset API returns the one-time reset token so the flow can be exercised locally. Production responses are generic and do not return the token; an email delivery adapter must be connected before production password resets are enabled.

See [docs/authentication-boundaries.md](docs/authentication-boundaries.md) for the ownership, session, CSRF, password, and reset rules that future Career Commander resources must follow.
