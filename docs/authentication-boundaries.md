# Authentication boundaries

Phase 2 establishes the identity boundary for Career Commander.

## Ownership rule

The authenticated session is the only source of the current user ID. Client request bodies and query strings must never be used as an ownership authority.

Every user-owned repository query must use the equivalent of:

```sql
WHERE resource.id = ? AND resource.user_id = authenticated_principal.id
```

The profile API demonstrates this with `getProfileByIdForUser`. Future Career Profile, Evidence, Opportunity, Analysis, Application, Discovery, Draft, Claim, Roadmap, and Audit repositories must follow the same pattern.

## Session rule

Sessions are opaque random tokens stored only as SHA-256 hashes in SQLite. The browser receives an HttpOnly, SameSite=Lax cookie. Login, signup, and password changes rotate sessions. Password reset revokes all existing sessions.

## CSRF rule

State-changing requests require same-origin validation and a CSRF token matching the CSRF cookie. Authenticated requests additionally require the token stored in the server-side session.

## Password rule

Passwords are hashed with salted scrypt. Plaintext passwords are never persisted, logged, returned, or included in audit metadata.

## Password reset rule

Reset tokens are random, stored only as hashes, expire after one hour, and are single-use. In development and tests the token is returned to make the local flow testable. Production responses are generic and require an email delivery adapter to send the token.

## Current Phase 3 scope

The authenticated boundary now includes the single Career Profile, education, skills,
projects, experience, and server-persisted onboarding state. Future Career Commander
resources must use the same principal-scoped repository pattern before they are exposed.
