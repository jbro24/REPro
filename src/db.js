const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomUUID();
}

function storedJson(value, fallback) {
  try { return JSON.parse(value || ''); } catch { return fallback; }
}

class AppDatabase {
  constructor(filePath) {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS reset_tokens_user_id_idx ON password_reset_tokens(user_id);

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_events_user_id_idx ON audit_events(user_id, created_at);

      CREATE TABLE IF NOT EXISTS education (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        institution TEXT NOT NULL,
        program TEXT NOT NULL,
        field_of_study TEXT NOT NULL DEFAULT '',
        start_date TEXT,
        end_date TEXT,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS education_user_id_idx ON education(user_id, updated_at);

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE,
        status TEXT NOT NULL CHECK (status IN ('VERIFIED', 'LEARNING', 'NO_EVIDENCE')),
        supporting_reference TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, name)
      );
      CREATE INDEX IF NOT EXISTS skills_user_id_idx ON skills(user_id, updated_at);

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        technologies_json TEXT NOT NULL DEFAULT '[]',
        role_contribution TEXT NOT NULL DEFAULT '',
        timeframe_start TEXT,
        timeframe_end TEXT,
        repository_url TEXT NOT NULL DEFAULT '',
        demo_url TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL DEFAULT '',
        associated_evidence TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS projects_user_id_idx ON projects(user_id, updated_at);

      CREATE TABLE IF NOT EXISTS experience (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        organization TEXT NOT NULL,
        role TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        start_date TEXT,
        end_date TEXT,
        responsibilities_json TEXT NOT NULL DEFAULT '[]',
        technologies_json TEXT NOT NULL DEFAULT '[]',
        evidence_reference TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS experience_user_id_idx ON experience(user_id, updated_at);

      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        evidence_type TEXT NOT NULL CHECK (evidence_type IN ('PROJECT', 'REPOSITORY', 'DEPLOYMENT', 'WORK_EXPERIENCE', 'CERTIFICATION', 'EDUCATION', 'DOCUMENT', 'PUBLICATION', 'PATENT', 'OTHER')),
        status_context TEXT NOT NULL CHECK (status_context IN ('VERIFIED', 'LEARNING', 'NO_EVIDENCE')),
        source_type TEXT NOT NULL CHECK (source_type IN ('USER_PROVIDED_REFERENCE', 'REPOSITORY', 'DOCUMENT', 'PUBLICATION', 'OTHER')),
        source_title TEXT NOT NULL DEFAULT '',
        source_reference TEXT NOT NULL,
        source_url TEXT NOT NULL DEFAULT '',
        timeframe_start TEXT,
        timeframe_end TEXT,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS evidence_user_id_idx ON evidence(user_id, updated_at);
      CREATE INDEX IF NOT EXISTS evidence_status_idx ON evidence(user_id, status_context);
      CREATE INDEX IF NOT EXISTS evidence_type_idx ON evidence(user_id, evidence_type);

      CREATE TABLE IF NOT EXISTS evidence_links (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        evidence_id TEXT NOT NULL,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('skill', 'project', 'experience', 'education')),
        entity_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (user_id, evidence_id, entity_type, entity_id)
      );
      CREATE INDEX IF NOT EXISTS evidence_links_entity_idx ON evidence_links(user_id, entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS evidence_links_evidence_idx ON evidence_links(user_id, evidence_id);

      CREATE TABLE IF NOT EXISTS opportunities (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        company TEXT NOT NULL,
        location TEXT NOT NULL DEFAULT '',
        raw_content TEXT NOT NULL,
        job_url TEXT NOT NULL DEFAULT '',
        canonical_url TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL CHECK (source_type IN ('MANUAL', 'INTERNET', 'EMAIL')),
        source_identifier TEXT NOT NULL DEFAULT '',
        source_reference TEXT NOT NULL DEFAULT '',
        discovered_at TEXT NOT NULL,
        source_timestamp TEXT,
        lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('NEW', 'ANALYZED', 'ARCHIVED')),
        normalized_title TEXT NOT NULL,
        normalized_company TEXT NOT NULL,
        normalized_content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS opportunities_user_idx ON opportunities(user_id, updated_at);
      CREATE INDEX IF NOT EXISTS opportunities_status_idx ON opportunities(user_id, lifecycle_status);

      CREATE TABLE IF NOT EXISTS opportunity_provenance (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL CHECK (source_type IN ('MANUAL', 'INTERNET', 'EMAIL')),
        source_identifier TEXT NOT NULL DEFAULT '',
        source_reference TEXT NOT NULL DEFAULT '',
        source_timestamp TEXT,
        discovered_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE (user_id, opportunity_id, source_type, source_identifier, source_reference)
      );
      CREATE INDEX IF NOT EXISTS opportunity_provenance_opp_idx ON opportunity_provenance(user_id, opportunity_id, created_at);

      CREATE TABLE IF NOT EXISTS job_requirements (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        requirements_version TEXT NOT NULL,
        analyst_version TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('READY', 'FAILED', 'STALE')),
        content_hash TEXT NOT NULL,
        requirements_json TEXT NOT NULL DEFAULT '{}',
        raw_output_json TEXT NOT NULL DEFAULT '{}',
        error_message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS job_requirements_user_opp_idx ON job_requirements(user_id, opportunity_id, created_at);

      CREATE TABLE IF NOT EXISTS match_runs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        job_requirements_id TEXT NOT NULL REFERENCES job_requirements(id) ON DELETE CASCADE,
        matcher_version TEXT NOT NULL,
        results_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS match_runs_user_opp_idx ON match_runs(user_id, opportunity_id, created_at);

      CREATE TABLE IF NOT EXISTS match_results (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        match_run_id TEXT NOT NULL REFERENCES match_runs(id) ON DELETE CASCADE,
        opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        requirement_id TEXT NOT NULL,
        requirement_type TEXT NOT NULL,
        priority TEXT NOT NULL CHECK (priority IN ('REQUIRED', 'PREFERRED')),
        requirement_text TEXT NOT NULL,
        match_state TEXT NOT NULL CHECK (match_state IN ('MATCH', 'PARTIAL', 'MISSING')),
        evidence_json TEXT NOT NULL DEFAULT '[]',
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (match_run_id, requirement_id)
      );
      CREATE INDEX IF NOT EXISTS match_results_run_idx ON match_results(user_id, match_run_id);

      CREATE TABLE IF NOT EXISTS score_breakdowns (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        match_run_id TEXT NOT NULL REFERENCES match_runs(id) ON DELETE CASCADE,
        job_requirements_id TEXT NOT NULL REFERENCES job_requirements(id) ON DELETE CASCADE,
        formula_version TEXT NOT NULL,
        score_json TEXT NOT NULL,
        overall_score REAL NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS score_breakdowns_user_opp_idx ON score_breakdowns(user_id, opportunity_id, created_at);

      CREATE TABLE IF NOT EXISTS gap_runs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        match_run_id TEXT NOT NULL REFERENCES match_runs(id) ON DELETE CASCADE,
        logic_version TEXT NOT NULL,
        gap_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gap_runs_user_opp_idx ON gap_runs(user_id, opportunity_id, created_at);

      CREATE TABLE IF NOT EXISTS gaps (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        match_run_id TEXT NOT NULL REFERENCES match_runs(id) ON DELETE CASCADE,
        requirement_id TEXT NOT NULL,
        priority TEXT NOT NULL CHECK (priority IN ('REQUIRED', 'PREFERRED')),
        gap_state TEXT NOT NULL CHECK (gap_state IN ('PARTIAL', 'MISSING')),
        requirement_text TEXT NOT NULL,
        current_evidence_json TEXT NOT NULL DEFAULT '[]',
        missing_capability TEXT NOT NULL,
        explanation TEXT NOT NULL,
        next_action TEXT NOT NULL DEFAULT '',
        logic_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (match_run_id, requirement_id)
      );
      CREATE INDEX IF NOT EXISTS gaps_user_opp_idx ON gaps(user_id, opportunity_id, created_at);

      CREATE TABLE IF NOT EXISTS discovery_runs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL CHECK (source_type IN ('WEB', 'EMAIL', 'MANUAL')),
        status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'PARTIAL')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        found_count INTEGER NOT NULL DEFAULT 0,
        new_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        rejected_count INTEGER NOT NULL DEFAULT 0,
        analyzed_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS discovery_runs_user_idx ON discovery_runs(user_id, started_at);

      CREATE TABLE IF NOT EXISTS mailbox_connections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider IN ('GMAIL', 'OUTLOOK', 'MOCK')),
        status TEXT NOT NULL CHECK (status IN ('CONFIGURED', 'CONNECTED', 'FAILED')),
        account_label TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, provider)
      );

      CREATE TABLE IF NOT EXISTS company_signals (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('READY', 'UNAVAILABLE', 'FAILED')),
        provider TEXT NOT NULL DEFAULT '',
        signals_json TEXT NOT NULL DEFAULT '[]',
        error_message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, opportunity_id)
      );
      CREATE TABLE IF NOT EXISTS project_relevance (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('READY', 'FAILED')),
        provider TEXT NOT NULL DEFAULT '',
        projects_json TEXT NOT NULL DEFAULT '[]',
        error_message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, opportunity_id)
      );
      CREATE TABLE IF NOT EXISTS roadmap_items (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        requirement_id TEXT NOT NULL,
        priority TEXT NOT NULL CHECK (priority IN ('REQUIRED', 'PREFERRED')),
        gap_state TEXT NOT NULL CHECK (gap_state IN ('PARTIAL', 'MISSING')),
        requirement_text TEXT NOT NULL,
        task TEXT NOT NULL,
        potential_evidence TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'SUGGESTED',
        logic_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS roadmap_items_opp_idx ON roadmap_items(user_id, opportunity_id, created_at);
      CREATE TABLE IF NOT EXISTS opportunity_reports (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('READY', 'FAILED')),
        provider TEXT NOT NULL DEFAULT '',
        report_json TEXT NOT NULL DEFAULT '{}',
        error_message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, opportunity_id)
      );
      CREATE TABLE IF NOT EXISTS roadmap_evidence_links (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        roadmap_item_id TEXT NOT NULL REFERENCES roadmap_items(id) ON DELETE CASCADE,
        evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        UNIQUE (user_id, roadmap_item_id, evidence_id)
      );
      CREATE INDEX IF NOT EXISTS roadmap_evidence_item_idx ON roadmap_evidence_links(user_id, roadmap_item_id);
      CREATE INDEX IF NOT EXISTS roadmap_evidence_evidence_idx ON roadmap_evidence_links(user_id, evidence_id);
      CREATE TABLE IF NOT EXISTS applications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('DRAFT', 'IN_REVIEW', 'READY_FOR_REVIEW', 'ARCHIVED')),
        draft_text TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT '',
        claim_summary_json TEXT NOT NULL DEFAULT '{}',
        review_note TEXT NOT NULL DEFAULT '',
        source_snapshot_json TEXT NOT NULL DEFAULT '{}',
        stale INTEGER NOT NULL DEFAULT 0,
        stale_reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, opportunity_id)
      );
      CREATE INDEX IF NOT EXISTS applications_user_idx ON applications(user_id, updated_at);
      CREATE TABLE IF NOT EXISTS application_claims (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        claim_order INTEGER NOT NULL,
        claim_text TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('SUPPORTED', 'UNSUPPORTED', 'NEEDS_REVIEW')),
        reason TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE (application_id, claim_order)
      );
      CREATE INDEX IF NOT EXISTS application_claims_app_idx ON application_claims(user_id, application_id, claim_order);
    `);
    this.migrateProfileColumns();
    this.migrateWorkflowColumns();
    this.migratePhase13Columns();
    this.migratePhase18Columns();
  }

  close() {
    this.db.close();
  }

  createUser({ email, passwordHash }) {
    const userId = newId();
    const profileId = newId();
    const timestamp = nowIso();
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        INSERT INTO users (id, email, password_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, email, passwordHash, timestamp, timestamp);
      this.db.prepare(`
        INSERT INTO profiles (id, user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(profileId, userId, timestamp, timestamp);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { id: userId, email, createdAt: timestamp, profileId };
  }

  getUserByEmail(email) {
    return this.db.prepare(`
      SELECT id, email, password_hash, created_at, updated_at
      FROM users WHERE email = ? COLLATE NOCASE
    `).get(email) || null;
  }

  getUserById(id) {
    return this.db.prepare(`
      SELECT id, email, created_at, updated_at FROM users WHERE id = ?
    `).get(id) || null;
  }

  getUserWithPasswordById(id) {
    return this.db.prepare(`
      SELECT id, email, password_hash, created_at, updated_at FROM users WHERE id = ?
    `).get(id) || null;
  }

  countUsers() {
    return this.db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  }

  migrateProfileColumns() {
    const existing = new Set(this.db.prepare('PRAGMA table_info(profiles)').all().map((column) => column.name));
    const columns = [
      ['name', "TEXT NOT NULL DEFAULT ''"],
      ['target_roles_json', "TEXT NOT NULL DEFAULT '[]'"],
      ['location', "TEXT NOT NULL DEFAULT ''"],
      ['current_status', "TEXT NOT NULL DEFAULT ''"],
      ['summary', "TEXT NOT NULL DEFAULT ''"],
      ['onboarding_step', "TEXT NOT NULL DEFAULT 'welcome'"],
      ['onboarding_completed', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [name, definition] of columns) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE profiles ADD COLUMN ${name} ${definition}`);
    }
  }

  migrateWorkflowColumns() {
    const existing = new Set(this.db.prepare('PRAGMA table_info(opportunities)').all().map((column) => column.name));
    const columns = [
      ['analysis_state', "TEXT NOT NULL DEFAULT 'NOT_STARTED'"],
      ['analysis_error', "TEXT NOT NULL DEFAULT ''"],
      ['analyzed_at', 'TEXT'],
    ];
    for (const [name, definition] of columns) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE opportunities ADD COLUMN ${name} ${definition}`);
    }
  }

  migratePhase13Columns() {
    this.db.prepare("UPDATE roadmap_items SET status = 'PLANNED' WHERE status = 'SUGGESTED'").run();
    const existing = new Set(this.db.prepare('PRAGMA table_info(roadmap_items)').all().map((column) => column.name));
    if (!existing.has('updated_at')) {
      this.db.exec("ALTER TABLE roadmap_items ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
      this.db.exec("UPDATE roadmap_items SET updated_at = created_at WHERE updated_at = ''");
    }
  }

  migratePhase18Columns() {
    const existing = new Set(this.db.prepare('PRAGMA table_info(applications)').all().map((column) => column.name));
    const columns = [
      ['source_snapshot_json', "TEXT NOT NULL DEFAULT '{}'"],
      ['stale', 'INTEGER NOT NULL DEFAULT 0'],
      ['stale_reason', "TEXT NOT NULL DEFAULT ''"],
    ];
    for (const [name, definition] of columns) if (!existing.has(name)) this.db.exec(`ALTER TABLE applications ADD COLUMN ${name} ${definition}`);
  }

  updatePassword(userId, passwordHash) {
    this.db.prepare(`
      UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?
    `).run(passwordHash, nowIso(), userId);
  }

  createSession({ userId, tokenHash, csrfToken, expiresAt }) {
    const id = newId();
    const createdAt = nowIso();
    this.db.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, csrf_token, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, userId, tokenHash, csrfToken, createdAt, expiresAt);
    return { id, userId, tokenHash, csrfToken, createdAt, expiresAt };
  }

  getSessionByTokenHash(tokenHash) {
    const row = this.db.prepare(`
      SELECT s.id, s.user_id, s.token_hash, s.csrf_token, s.created_at, s.expires_at,
             u.email, u.created_at AS user_created_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
    `).get(tokenHash);
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      this.deleteSessionByTokenHash(tokenHash);
      return null;
    }
    return row;
  }

  deleteSessionByTokenHash(tokenHash) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteSessionsForUser(userId) {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  createPasswordReset({ userId, tokenHash, expiresAt }) {
    const createdAt = nowIso();
    this.db.prepare(`
      UPDATE password_reset_tokens SET used_at = ?
      WHERE user_id = ? AND used_at IS NULL
    `).run(createdAt, userId);
    const id = newId();
    this.db.prepare(`
      INSERT INTO password_reset_tokens (id, user_id, token_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, userId, tokenHash, createdAt, expiresAt);
    return { id, userId, expiresAt };
  }

  consumePasswordReset(tokenHash) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`
        SELECT id, user_id FROM password_reset_tokens
        WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
      `).get(tokenHash, nowIso());
      if (!row) {
        this.db.exec('ROLLBACK');
        return null;
      }
      this.db.prepare(`
        UPDATE password_reset_tokens SET used_at = ? WHERE id = ?
      `).run(nowIso(), row.id);
      this.db.exec('COMMIT');
      return row.user_id;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getProfileByIdForUser(profileId, userId) {
    return this.db.prepare(`
      SELECT id, name, target_roles_json, location, current_status, summary,
             onboarding_step, onboarding_completed, created_at, updated_at
      FROM profiles WHERE id = ? AND user_id = ?
    `).get(profileId, userId) || null;
  }

  getProfileForUser(userId) {
    return this.db.prepare(`
      SELECT id, name, target_roles_json, location, current_status, summary,
             onboarding_step, onboarding_completed, created_at, updated_at
      FROM profiles WHERE user_id = ?
    `).get(userId) || null;
  }

  updateProfileForUser(userId, profile) {
    this.db.prepare(`
      UPDATE profiles
      SET name = ?, target_roles_json = ?, location = ?, current_status = ?, summary = ?, updated_at = ?
      WHERE user_id = ?
    `).run(profile.name, JSON.stringify(profile.targetRoles), profile.location, profile.currentStatus, profile.summary, nowIso(), userId);
    this.markAnalysesStaleForUser(userId);
    return this.getProfileForUser(userId);
  }

  markAnalysesStaleForUser(userId) {
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE opportunities
      SET analysis_state = 'STALE',
          analysis_error = 'Candidate context changed; rerun analysis to refresh this report.',
          updated_at = ?
      WHERE user_id = ? AND analysis_state NOT IN ('NOT_STARTED', 'STALE')
    `).run(timestamp, userId);
    this.db.prepare(`
      UPDATE job_requirements
      SET status = 'STALE', updated_at = ?
      WHERE user_id = ? AND status = 'READY'
    `).run(timestamp, userId);
    this.db.prepare(`
      UPDATE applications
      SET stale = 1, stale_reason = 'Candidate evidence or profile changed.', updated_at = ?
      WHERE user_id = ?
    `).run(timestamp, userId);
  }

  getCandidateContextFingerprintForUser(userId) {
    const snapshot = {
      profile: this.db.prepare('SELECT id, name, target_roles_json, location, current_status, summary, updated_at FROM profiles WHERE user_id = ?').get(userId) || null,
      education: this.db.prepare('SELECT id, institution, program, field_of_study, start_date, end_date, description, updated_at FROM education WHERE user_id = ? ORDER BY id').all(userId),
      skills: this.db.prepare('SELECT id, name, status, supporting_reference, description, updated_at FROM skills WHERE user_id = ? ORDER BY id').all(userId),
      projects: this.db.prepare('SELECT id, name, description, technologies_json, role_contribution, timeframe_start, timeframe_end, repository_url, demo_url, outcome, associated_evidence, updated_at FROM projects WHERE user_id = ? ORDER BY id').all(userId),
      experience: this.db.prepare('SELECT id, organization, role, description, start_date, end_date, responsibilities_json, technologies_json, evidence_reference, updated_at FROM experience WHERE user_id = ? ORDER BY id').all(userId),
      evidence: this.db.prepare('SELECT id, title, description, evidence_type, status_context, source_type, source_title, source_reference, source_url, timeframe_start, timeframe_end, notes, updated_at FROM evidence WHERE user_id = ? ORDER BY id').all(userId),
      evidenceLinks: this.db.prepare('SELECT evidence_id, entity_type, entity_id, created_at FROM evidence_links WHERE user_id = ? ORDER BY evidence_id, entity_type, entity_id').all(userId),
    };
    return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  }

  updateOnboardingForUser(userId, { step, completed }) {
    this.db.prepare(`
      UPDATE profiles SET onboarding_step = ?, onboarding_completed = ?, updated_at = ?
      WHERE user_id = ?
    `).run(step, completed ? 1 : 0, nowIso(), userId);
    return this.getProfileForUser(userId);
  }

  listEducationForUser(userId) {
    return this.db.prepare(`
      SELECT id, institution, program, field_of_study, start_date, end_date, description, created_at, updated_at
      FROM education WHERE user_id = ? ORDER BY COALESCE(end_date, start_date, created_at) DESC, created_at DESC
    `).all(userId);
  }

  getEducationByIdForUser(id, userId) {
    return this.db.prepare('SELECT id, institution, program, field_of_study, start_date, end_date, description, created_at, updated_at FROM education WHERE id = ? AND user_id = ?').get(id, userId) || null;
  }

  createEducation(userId, value) {
    const id = newId();
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO education (id, user_id, institution, program, field_of_study, start_date, end_date, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, value.institution, value.program, value.field, value.startDate || null, value.endDate || null, value.description, timestamp, timestamp);
    this.markAnalysesStaleForUser(userId);
    return this.getEducationByIdForUser(id, userId);
  }

  updateEducationForUser(id, userId, value) {
    const result = this.db.prepare(`
      UPDATE education SET institution = ?, program = ?, field_of_study = ?, start_date = ?, end_date = ?, description = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(value.institution, value.program, value.field, value.startDate || null, value.endDate || null, value.description, nowIso(), id, userId);
    if (!result.changes) return null;
    this.markAnalysesStaleForUser(userId);
    return this.getEducationByIdForUser(id, userId);
  }

  deleteEducationForUser(id, userId) {
    this.db.prepare('DELETE FROM evidence_links WHERE entity_type = \'education\' AND entity_id = ? AND user_id = ?').run(id, userId);
    const deleted = this.db.prepare('DELETE FROM education WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
    if (deleted) this.markAnalysesStaleForUser(userId);
    return deleted;
  }

  listSkillsForUser(userId) {
    return this.db.prepare('SELECT id, name, status, supporting_reference, description, created_at, updated_at FROM skills WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(userId);
  }

  getSkillByIdForUser(id, userId) {
    return this.db.prepare('SELECT id, name, status, supporting_reference, description, created_at, updated_at FROM skills WHERE id = ? AND user_id = ?').get(id, userId) || null;
  }

  createSkill(userId, value) {
    const id = newId();
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO skills (id, user_id, name, status, supporting_reference, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, value.name, value.status, value.supportingReference, value.description, timestamp, timestamp);
    this.markAnalysesStaleForUser(userId);
    return this.getSkillByIdForUser(id, userId);
  }

  updateSkillForUser(id, userId, value) {
    const result = this.db.prepare(`
      UPDATE skills SET name = ?, status = ?, supporting_reference = ?, description = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(value.name, value.status, value.supportingReference, value.description, nowIso(), id, userId);
    if (!result.changes) return null;
    this.markAnalysesStaleForUser(userId);
    return this.getSkillByIdForUser(id, userId);
  }

  deleteSkillForUser(id, userId) {
    this.db.prepare('DELETE FROM evidence_links WHERE entity_type = \'skill\' AND entity_id = ? AND user_id = ?').run(id, userId);
    const deleted = this.db.prepare('DELETE FROM skills WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
    if (deleted) this.markAnalysesStaleForUser(userId);
    return deleted;
  }

  listProjectsForUser(userId) {
    return this.db.prepare('SELECT id, name, description, technologies_json, role_contribution, timeframe_start, timeframe_end, repository_url, demo_url, outcome, associated_evidence, created_at, updated_at FROM projects WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
  }

  getProjectByIdForUser(id, userId) {
    return this.db.prepare('SELECT id, name, description, technologies_json, role_contribution, timeframe_start, timeframe_end, repository_url, demo_url, outcome, associated_evidence, created_at, updated_at FROM projects WHERE id = ? AND user_id = ?').get(id, userId) || null;
  }

  createProject(userId, value) {
    const id = newId();
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO projects (id, user_id, name, description, technologies_json, role_contribution, timeframe_start, timeframe_end, repository_url, demo_url, outcome, associated_evidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, value.name, value.description, JSON.stringify(value.technologies), value.roleContribution, value.timeframeStart || null, value.timeframeEnd || null, value.repositoryUrl, value.demoUrl, value.outcome, value.associatedEvidence, timestamp, timestamp);
    this.markAnalysesStaleForUser(userId);
    return this.getProjectByIdForUser(id, userId);
  }

  updateProjectForUser(id, userId, value) {
    const result = this.db.prepare(`
      UPDATE projects SET name = ?, description = ?, technologies_json = ?, role_contribution = ?, timeframe_start = ?, timeframe_end = ?, repository_url = ?, demo_url = ?, outcome = ?, associated_evidence = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(value.name, value.description, JSON.stringify(value.technologies), value.roleContribution, value.timeframeStart || null, value.timeframeEnd || null, value.repositoryUrl, value.demoUrl, value.outcome, value.associatedEvidence, nowIso(), id, userId);
    if (!result.changes) return null;
    this.markAnalysesStaleForUser(userId);
    return this.getProjectByIdForUser(id, userId);
  }

  deleteProjectForUser(id, userId) {
    this.db.prepare('DELETE FROM evidence_links WHERE entity_type = \'project\' AND entity_id = ? AND user_id = ?').run(id, userId);
    const deleted = this.db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
    if (deleted) this.markAnalysesStaleForUser(userId);
    return deleted;
  }

  listExperienceForUser(userId) {
    return this.db.prepare('SELECT id, organization, role, description, start_date, end_date, responsibilities_json, technologies_json, evidence_reference, created_at, updated_at FROM experience WHERE user_id = ? ORDER BY COALESCE(end_date, start_date, created_at) DESC, created_at DESC').all(userId);
  }

  getExperienceByIdForUser(id, userId) {
    return this.db.prepare('SELECT id, organization, role, description, start_date, end_date, responsibilities_json, technologies_json, evidence_reference, created_at, updated_at FROM experience WHERE id = ? AND user_id = ?').get(id, userId) || null;
  }

  createExperience(userId, value) {
    const id = newId();
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO experience (id, user_id, organization, role, description, start_date, end_date, responsibilities_json, technologies_json, evidence_reference, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, value.organization, value.role, value.description, value.startDate || null, value.endDate || null, JSON.stringify(value.responsibilities), JSON.stringify(value.technologies), value.evidenceReference, timestamp, timestamp);
    this.markAnalysesStaleForUser(userId);
    return this.getExperienceByIdForUser(id, userId);
  }

  updateExperienceForUser(id, userId, value) {
    const result = this.db.prepare(`
      UPDATE experience SET organization = ?, role = ?, description = ?, start_date = ?, end_date = ?, responsibilities_json = ?, technologies_json = ?, evidence_reference = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(value.organization, value.role, value.description, value.startDate || null, value.endDate || null, JSON.stringify(value.responsibilities), JSON.stringify(value.technologies), value.evidenceReference, nowIso(), id, userId);
    if (!result.changes) return null;
    this.markAnalysesStaleForUser(userId);
    return this.getExperienceByIdForUser(id, userId);
  }

  deleteExperienceForUser(id, userId) {
    this.db.prepare('DELETE FROM evidence_links WHERE entity_type = \'experience\' AND entity_id = ? AND user_id = ?').run(id, userId);
    const deleted = this.db.prepare('DELETE FROM experience WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
    if (deleted) this.markAnalysesStaleForUser(userId);
    return deleted;
  }

  opportunityProvenanceView(row) {
    return {
      id: row.id,
      sourceType: row.source_type,
      sourceIdentifier: row.source_identifier,
      sourceReference: row.source_reference,
      sourceTimestamp: row.source_timestamp,
      discoveredAt: row.discovered_at,
      metadata: storedJson(row.metadata_json, {}),
      createdAt: row.created_at,
    };
  }

  getOpportunityProvenanceForUser(opportunityId, userId) {
    return this.db.prepare(`
      SELECT id, source_type, source_identifier, source_reference, source_timestamp,
             discovered_at, metadata_json, created_at
      FROM opportunity_provenance
      WHERE opportunity_id = ? AND user_id = ?
      ORDER BY created_at ASC
    `).all(opportunityId, userId).map((row) => this.opportunityProvenanceView(row));
  }

  opportunityView(row, userId) {
    if (!row) return null;
    return {
      ...row,
      provenance: this.getOpportunityProvenanceForUser(row.id, userId),
    };
  }

  getOpportunityByIdForUser(id, userId) {
    const row = this.db.prepare(`
      SELECT id, title, company, location, raw_content, job_url, canonical_url,
             source_type, source_identifier, source_reference, discovered_at,
             source_timestamp, lifecycle_status, normalized_title, normalized_company,
             normalized_content, content_hash, dedupe_key, analysis_state, analysis_error,
             analyzed_at, created_at, updated_at
      FROM opportunities WHERE id = ? AND user_id = ?
    `).get(id, userId);
    return this.opportunityView(row, userId);
  }

  listOpportunitiesForUser(userId) {
    return this.db.prepare(`
      SELECT id, title, company, location, raw_content, job_url, canonical_url,
             source_type, source_identifier, source_reference, discovered_at,
             source_timestamp, lifecycle_status, normalized_title, normalized_company,
             normalized_content, content_hash, dedupe_key, analysis_state, analysis_error,
             analyzed_at, created_at, updated_at
      FROM opportunities WHERE user_id = ? ORDER BY updated_at DESC
    `).all(userId).map((row) => this.opportunityView(row, userId));
  }

  findOpportunityByDedupeKeyForUser(dedupeKey, userId) {
    const row = this.db.prepare(`
      SELECT id, title, company, location, raw_content, job_url, canonical_url,
             source_type, source_identifier, source_reference, discovered_at,
             source_timestamp, lifecycle_status, normalized_title, normalized_company,
             normalized_content, content_hash, dedupe_key, analysis_state, analysis_error,
             analyzed_at, created_at, updated_at
      FROM opportunities WHERE dedupe_key = ? AND user_id = ?
    `).get(dedupeKey, userId);
    return this.opportunityView(row, userId);
  }

  addOpportunityProvenanceForUser(opportunityId, userId, value, discoveredAt = nowIso()) {
    this.db.prepare(`
      INSERT OR IGNORE INTO opportunity_provenance
        (id, user_id, opportunity_id, source_type, source_identifier, source_reference, source_timestamp, discovered_at, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(newId(), userId, opportunityId, value.sourceType, value.sourceIdentifier, value.sourceReference, value.sourceTimestamp || null, discoveredAt, JSON.stringify(value.provenanceMetadata || {}), discoveredAt);
    return this.getOpportunityProvenanceForUser(opportunityId, userId);
  }

  createOrReuseOpportunityForUser(userId, value) {
    const discoveredAt = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT id FROM opportunities WHERE user_id = ? AND dedupe_key = ?').get(userId, value.dedupeKey);
      if (existing) {
        this.addOpportunityProvenanceForUser(existing.id, userId, value, discoveredAt);
        this.db.exec('COMMIT');
        return { opportunity: this.getOpportunityByIdForUser(existing.id, userId), duplicate: true };
      }
      const id = newId();
      this.db.prepare(`
        INSERT INTO opportunities
          (id, user_id, title, company, location, raw_content, job_url, canonical_url,
           source_type, source_identifier, source_reference, discovered_at, source_timestamp,
           lifecycle_status, normalized_title, normalized_company, normalized_content,
           content_hash, dedupe_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, userId, value.title, value.company, value.location, value.rawContent, value.url, value.canonicalUrl, value.sourceType, value.sourceIdentifier, value.sourceReference, discoveredAt, value.sourceTimestamp || null, value.lifecycleStatus, value.normalizedTitle, value.normalizedCompany, value.normalizedContent, value.contentHash, value.dedupeKey, discoveredAt, discoveredAt);
      this.addOpportunityProvenanceForUser(id, userId, value, discoveredAt);
      this.db.exec('COMMIT');
      return { opportunity: this.getOpportunityByIdForUser(id, userId), duplicate: false };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  updateOpportunityForUser(id, userId, value) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const collision = this.db.prepare('SELECT id FROM opportunities WHERE user_id = ? AND dedupe_key = ? AND id <> ?').get(userId, value.dedupeKey, id);
      if (collision) {
        this.db.exec('ROLLBACK');
        const error = new Error('Another opportunity already represents this source.');
        error.code = 'DUPLICATE_OPPORTUNITY';
        throw error;
      }
      const prior = this.db.prepare('SELECT content_hash FROM opportunities WHERE id = ? AND user_id = ?').get(id, userId);
      const result = this.db.prepare(`
        UPDATE opportunities SET title = ?, company = ?, location = ?, raw_content = ?, job_url = ?, canonical_url = ?,
          source_type = ?, source_identifier = ?, source_reference = ?, source_timestamp = ?, lifecycle_status = ?,
          normalized_title = ?, normalized_company = ?, normalized_content = ?, content_hash = ?, dedupe_key = ?,
          analysis_state = CASE WHEN ? <> content_hash THEN 'STALE' ELSE analysis_state END,
          analysis_error = CASE WHEN ? <> content_hash THEN '' ELSE analysis_error END, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(value.title, value.company, value.location, value.rawContent, value.url, value.canonicalUrl, value.sourceType, value.sourceIdentifier, value.sourceReference, value.sourceTimestamp || null, value.lifecycleStatus, value.normalizedTitle, value.normalizedCompany, value.normalizedContent, value.contentHash, value.dedupeKey, value.contentHash, value.contentHash, nowIso(), id, userId);
      if (!result.changes) {
        this.db.exec('ROLLBACK');
        return null;
      }
      if (prior && prior.content_hash !== value.contentHash) this.db.prepare("UPDATE job_requirements SET status = 'STALE', updated_at = ? WHERE opportunity_id = ? AND user_id = ? AND status = 'READY'").run(nowIso(), id, userId);
      if (prior && prior.content_hash !== value.contentHash) this.db.prepare("UPDATE applications SET stale = 1, stale_reason = 'Opportunity content changed.', updated_at = ? WHERE opportunity_id = ? AND user_id = ?").run(nowIso(), id, userId);
      this.addOpportunityProvenanceForUser(id, userId, value);
      this.db.exec('COMMIT');
      return this.getOpportunityByIdForUser(id, userId);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  deleteOpportunityForUser(id, userId) {
    return this.db.prepare('DELETE FROM opportunities WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }

  setOpportunityLifecycleStatusForUser(id, userId, status) {
    this.db.prepare('UPDATE opportunities SET lifecycle_status = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(status, nowIso(), id, userId);
    return this.getOpportunityByIdForUser(id, userId);
  }

  updateOpportunityAnalysisForUser(id, userId, state, errorMessage = '') {
    const analyzedAt = state === 'COMPLETE' ? nowIso() : null;
    this.db.prepare('UPDATE opportunities SET analysis_state = ?, analysis_error = ?, analyzed_at = COALESCE(?, analyzed_at), updated_at = ? WHERE id = ? AND user_id = ?').run(state, errorMessage, analyzedAt, nowIso(), id, userId);
    return this.getOpportunityByIdForUser(id, userId);
  }

  opportunityAnalysisSummaryForUser(opportunityId, userId) {
    const row = this.db.prepare(`
      SELECT o.analysis_state, o.analysis_error, o.analyzed_at,
        (SELECT overall_score FROM score_breakdowns WHERE opportunity_id = o.id AND user_id = o.user_id ORDER BY created_at DESC LIMIT 1) AS overall_score,
        (SELECT COUNT(*) FROM gaps WHERE opportunity_id = o.id AND user_id = o.user_id AND match_run_id = (SELECT match_run_id FROM gap_runs WHERE opportunity_id = o.id AND user_id = o.user_id ORDER BY created_at DESC LIMIT 1)) AS gap_count,
        (SELECT COUNT(*) FROM gaps WHERE opportunity_id = o.id AND user_id = o.user_id AND priority = 'REQUIRED' AND match_run_id = (SELECT match_run_id FROM gap_runs WHERE opportunity_id = o.id AND user_id = o.user_id ORDER BY created_at DESC LIMIT 1)) AS required_gap_count
      FROM opportunities o WHERE o.id = ? AND o.user_id = ?
    `).get(opportunityId, userId);
    return row ? { analysisState: row.analysis_state, analysisError: row.analysis_error, analyzedAt: row.analyzed_at, overallScore: row.overall_score, gapCount: row.gap_count, requiredGapCount: row.required_gap_count } : null;
  }

  createDiscoveryRunForUser(userId, { sourceType, metadata = {} }) {
    const id = newId();
    const startedAt = nowIso();
    this.db.prepare('INSERT INTO discovery_runs (id, user_id, source_type, status, started_at, metadata_json) VALUES (?, ?, ?, \'RUNNING\', ?, ?)').run(id, userId, sourceType, startedAt, JSON.stringify(metadata));
    return this.getDiscoveryRunForUser(id, userId);
  }

  getDiscoveryRunForUser(id, userId) {
    const row = this.db.prepare('SELECT id, source_type, status, started_at, completed_at, found_count, new_count, duplicate_count, rejected_count, analyzed_count, error_message, metadata_json FROM discovery_runs WHERE id = ? AND user_id = ?').get(id, userId);
    if (!row) return null;
    return { id: row.id, sourceType: row.source_type, status: row.status, startedAt: row.started_at, completedAt: row.completed_at, foundCount: row.found_count, newCount: row.new_count, duplicateCount: row.duplicate_count, rejectedCount: row.rejected_count, analyzedCount: row.analyzed_count, errorMessage: row.error_message, metadata: storedJson(row.metadata_json, {}) };
  }

  listDiscoveryRunsForUser(userId) {
    return this.db.prepare('SELECT id FROM discovery_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT 30').all(userId).map((row) => this.getDiscoveryRunForUser(row.id, userId));
  }

  finishDiscoveryRunForUser(id, userId, result) {
    this.db.prepare('UPDATE discovery_runs SET status = ?, completed_at = ?, found_count = ?, new_count = ?, duplicate_count = ?, rejected_count = ?, analyzed_count = ?, error_message = ? WHERE id = ? AND user_id = ?').run(result.status, nowIso(), result.foundCount || 0, result.newCount || 0, result.duplicateCount || 0, result.rejectedCount || 0, result.analyzedCount || 0, result.errorMessage || '', id, userId);
    return this.getDiscoveryRunForUser(id, userId);
  }

  saveMailboxConnectionForUser(userId, { provider, status = 'CONFIGURED', accountLabel = '', metadata = {} }) {
    const timestamp = nowIso();
    const existing = this.db.prepare('SELECT id FROM mailbox_connections WHERE user_id = ? AND provider = ?').get(userId, provider);
    if (existing) this.db.prepare('UPDATE mailbox_connections SET status = ?, account_label = ?, metadata_json = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(status, accountLabel, JSON.stringify(metadata), timestamp, existing.id, userId);
    else this.db.prepare('INSERT INTO mailbox_connections (id, user_id, provider, status, account_label, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(newId(), userId, provider, status, accountLabel, JSON.stringify(metadata), timestamp, timestamp);
    return this.getMailboxConnectionForUser(userId, provider);
  }

  getMailboxConnectionForUser(userId, provider = '') {
    const row = this.db.prepare(`SELECT id, provider, status, account_label, metadata_json, created_at, updated_at FROM mailbox_connections WHERE user_id = ? ${provider ? 'AND provider = ?' : ''} ORDER BY updated_at DESC LIMIT 1`).get(...(provider ? [userId, provider] : [userId]));
    return row ? { id: row.id, provider: row.provider, status: row.status, accountLabel: row.account_label, metadata: storedJson(row.metadata_json, {}), createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  listMailboxConnectionsForUser(userId) {
    return this.db.prepare('SELECT id, provider, status, account_label, metadata_json, created_at, updated_at FROM mailbox_connections WHERE user_id = ? ORDER BY updated_at DESC').all(userId).map((row) => ({ id: row.id, provider: row.provider, status: row.status, accountLabel: row.account_label, metadata: storedJson(row.metadata_json, {}), createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  saveCompanySignalsForUser(userId, opportunityId, value) {
    const timestamp = nowIso();
    const existing = this.db.prepare('SELECT id FROM company_signals WHERE user_id = ? AND opportunity_id = ?').get(userId, opportunityId);
    if (existing) this.db.prepare('UPDATE company_signals SET status = ?, provider = ?, signals_json = ?, error_message = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(value.status, value.provider || '', JSON.stringify(value.signals || []), value.errorMessage || '', timestamp, existing.id, userId);
    else this.db.prepare('INSERT INTO company_signals (id, user_id, opportunity_id, status, provider, signals_json, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(newId(), userId, opportunityId, value.status, value.provider || '', JSON.stringify(value.signals || []), value.errorMessage || '', timestamp, timestamp);
    return this.getCompanySignalsForUser(opportunityId, userId);
  }

  getCompanySignalsForUser(opportunityId, userId) {
    const row = this.db.prepare('SELECT id, opportunity_id, status, provider, signals_json, error_message, created_at, updated_at FROM company_signals WHERE opportunity_id = ? AND user_id = ?').get(opportunityId, userId);
    return row ? { id: row.id, opportunityId: row.opportunity_id, status: row.status, provider: row.provider, signals: storedJson(row.signals_json, []), errorMessage: row.error_message, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  saveProjectRelevanceForUser(userId, opportunityId, value) {
    const timestamp = nowIso();
    const existing = this.db.prepare('SELECT id FROM project_relevance WHERE user_id = ? AND opportunity_id = ?').get(userId, opportunityId);
    if (existing) this.db.prepare('UPDATE project_relevance SET status = ?, provider = ?, projects_json = ?, error_message = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(value.status, value.provider || '', JSON.stringify(value.projects || []), value.errorMessage || '', timestamp, existing.id, userId);
    else this.db.prepare('INSERT INTO project_relevance (id, user_id, opportunity_id, status, provider, projects_json, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(newId(), userId, opportunityId, value.status, value.provider || '', JSON.stringify(value.projects || []), value.errorMessage || '', timestamp, timestamp);
    return this.getProjectRelevanceForUser(opportunityId, userId);
  }

  getProjectRelevanceForUser(opportunityId, userId) {
    const row = this.db.prepare('SELECT id, opportunity_id, status, provider, projects_json, error_message, created_at, updated_at FROM project_relevance WHERE opportunity_id = ? AND user_id = ?').get(opportunityId, userId);
    return row ? { id: row.id, opportunityId: row.opportunity_id, status: row.status, provider: row.provider, projects: storedJson(row.projects_json, []), errorMessage: row.error_message, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  replaceRoadmapItemsForUser(userId, opportunityId, items) {
    const timestamp = nowIso();
    const existing = this.db.prepare('SELECT id, requirement_id, priority, gap_state, status, created_at FROM roadmap_items WHERE user_id = ? AND opportunity_id = ?').all(userId, opportunityId);
    const existingByKey = new Map(existing.map((row) => [`${row.requirement_id}|${row.priority}|${row.gap_state}`, row]));
    const statement = this.db.prepare('INSERT INTO roadmap_items (id, user_id, opportunity_id, requirement_id, priority, gap_state, requirement_text, task, potential_evidence, status, logic_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const retained = new Set();
    for (const item of items) {
      const key = `${item.requirementId}|${item.priority}|${item.gapState}`;
      const previous = existingByKey.get(key);
      if (previous) {
        retained.add(previous.id);
        this.db.prepare('UPDATE roadmap_items SET requirement_text = ?, task = ?, potential_evidence = ?, logic_version = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(item.requirementText, item.task, item.potentialEvidence, item.logicVersion, timestamp, previous.id, userId);
      } else {
        statement.run(newId(), userId, opportunityId, item.requirementId, item.priority, item.gapState, item.requirementText, item.task, item.potentialEvidence, item.status || 'PLANNED', item.logicVersion, timestamp, timestamp);
      }
    }
    for (const row of existing) if (!retained.has(row.id) && !items.some((item) => `${item.requirementId}|${item.priority}|${item.gapState}` === `${row.requirement_id}|${row.priority}|${row.gap_state}`)) this.db.prepare('DELETE FROM roadmap_items WHERE id = ? AND user_id = ?').run(row.id, userId);
    return this.getRoadmapItemsForUser(opportunityId, userId);
  }

  getRoadmapItemsForUser(opportunityId, userId) {
    return this.db.prepare('SELECT id, opportunity_id, requirement_id, priority, gap_state, requirement_text, task, potential_evidence, status, logic_version, created_at, updated_at FROM roadmap_items WHERE opportunity_id = ? AND user_id = ? ORDER BY CASE priority WHEN \'REQUIRED\' THEN 0 ELSE 1 END, created_at').all(opportunityId, userId).map((row) => ({ id: row.id, opportunityId: row.opportunity_id, requirementId: row.requirement_id, priority: row.priority, gapState: row.gap_state, requirementText: row.requirement_text, task: row.task, potentialEvidence: row.potential_evidence, status: row.status === 'SUGGESTED' ? 'PLANNED' : row.status, logicVersion: row.logic_version, createdAt: row.created_at, updatedAt: row.updated_at || row.created_at, evidence: this.getRoadmapEvidenceForUser(row.id, userId) }));
  }

  updateRoadmapItemStatusForUser(id, userId, status) {
    if (!['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'SKIPPED'].includes(status)) return null;
    this.db.prepare('UPDATE roadmap_items SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(status, nowIso(), id, userId);
    const row = this.db.prepare('SELECT opportunity_id FROM roadmap_items WHERE id = ? AND user_id = ?').get(id, userId);
    if (!row) return null;
    return this.getRoadmapItemsForUser(row.opportunity_id, userId).find((item) => item.id === id) || null;
  }

  getRoadmapEvidenceForUser(roadmapItemId, userId) {
    return this.db.prepare(`
      SELECT e.id, e.title, e.description, e.status_context, e.evidence_type, e.source_reference, rel.created_at
      FROM roadmap_evidence_links rel JOIN evidence e ON e.id = rel.evidence_id AND e.user_id = rel.user_id
      WHERE rel.roadmap_item_id = ? AND rel.user_id = ? ORDER BY rel.created_at
    `).all(roadmapItemId, userId).map((row) => ({ id: row.id, title: row.title, description: row.description, status: row.status_context, evidenceType: row.evidence_type, sourceReference: row.source_reference, linkedAt: row.created_at }));
  }

  linkEvidenceToRoadmapItemForUser(userId, roadmapItemId, evidenceId) {
    const valid = this.db.prepare(`
      SELECT r.id, r.opportunity_id FROM roadmap_items r JOIN evidence e ON e.user_id = r.user_id
      WHERE r.id = ? AND r.user_id = ? AND e.id = ? AND e.user_id = ?
    `).get(roadmapItemId, userId, evidenceId, userId);
    if (!valid) return null;
    this.db.prepare('INSERT OR IGNORE INTO roadmap_evidence_links (id, user_id, roadmap_item_id, evidence_id, created_at) VALUES (?, ?, ?, ?, ?)').run(newId(), userId, roadmapItemId, evidenceId, nowIso());
    return { roadmapItemId, opportunityId: valid.opportunity_id, evidence: this.getRoadmapEvidenceForUser(roadmapItemId, userId) };
  }

  unlinkEvidenceFromRoadmapItemForUser(userId, roadmapItemId, evidenceId) {
    const valid = this.db.prepare('SELECT opportunity_id FROM roadmap_items WHERE id = ? AND user_id = ?').get(roadmapItemId, userId);
    if (!valid) return null;
    const deleted = this.db.prepare('DELETE FROM roadmap_evidence_links WHERE roadmap_item_id = ? AND evidence_id = ? AND user_id = ?').run(roadmapItemId, evidenceId, userId).changes > 0;
    return { roadmapItemId, opportunityId: valid.opportunity_id, deleted, evidence: this.getRoadmapEvidenceForUser(roadmapItemId, userId) };
  }

  applicationView(row, userId) {
    if (!row) return null;
    const application = { id: row.id, userId: row.user_id, opportunityId: row.opportunity_id, status: row.status, draftText: row.draft_text, provider: row.provider, claimSummary: storedJson(row.claim_summary_json, {}), reviewNote: row.review_note, sourceSnapshot: storedJson(row.source_snapshot_json, {}), stale: Boolean(row.stale), staleReason: row.stale_reason || '', createdAt: row.created_at, updatedAt: row.updated_at };
    application.claims = this.getApplicationClaimsForUser(row.id, userId);
    return application;
  }

  getApplicationForUser(id, userId) {
    const row = this.db.prepare('SELECT id, user_id, opportunity_id, status, draft_text, provider, claim_summary_json, review_note, source_snapshot_json, stale, stale_reason, created_at, updated_at FROM applications WHERE id = ? AND user_id = ?').get(id, userId);
    return this.applicationView(row, userId);
  }

  getApplicationForOpportunityForUser(opportunityId, userId) {
    const row = this.db.prepare('SELECT id, user_id, opportunity_id, status, draft_text, provider, claim_summary_json, review_note, source_snapshot_json, stale, stale_reason, created_at, updated_at FROM applications WHERE opportunity_id = ? AND user_id = ?').get(opportunityId, userId);
    return this.applicationView(row, userId);
  }

  listApplicationsForUser(userId) {
    return this.db.prepare('SELECT id, user_id, opportunity_id, status, draft_text, provider, claim_summary_json, review_note, source_snapshot_json, stale, stale_reason, created_at, updated_at FROM applications WHERE user_id = ? ORDER BY updated_at DESC').all(userId).map((row) => this.applicationView(row, userId));
  }

  createApplicationForUser(userId, value) {
    const id = newId();
    const timestamp = nowIso();
    this.db.prepare('INSERT INTO applications (id, user_id, opportunity_id, status, draft_text, provider, claim_summary_json, review_note, source_snapshot_json, stale, stale_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, userId, value.opportunityId, value.status || 'DRAFT', value.draftText, value.provider || '', JSON.stringify(value.claimSummary || {}), value.reviewNote || '', JSON.stringify(value.sourceSnapshot || {}), value.stale ? 1 : 0, value.staleReason || '', timestamp, timestamp);
    return this.getApplicationForUser(id, userId);
  }

  updateApplicationForUser(id, userId, value) {
    const current = this.getApplicationForUser(id, userId);
    if (!current) return null;
    const timestamp = nowIso();
    this.db.prepare('UPDATE applications SET status = ?, draft_text = ?, claim_summary_json = ?, review_note = ?, source_snapshot_json = ?, stale = ?, stale_reason = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(value.status || current.status, value.draftText ?? current.draftText, JSON.stringify(value.claimSummary || current.claimSummary || {}), value.reviewNote ?? current.reviewNote, JSON.stringify(value.sourceSnapshot ?? current.sourceSnapshot ?? {}), value.stale === undefined ? (current.stale ? 1 : 0) : (value.stale ? 1 : 0), value.staleReason ?? current.staleReason ?? '', timestamp, id, userId);
    return this.getApplicationForUser(id, userId);
  }

  replaceApplicationClaimsForUser(userId, applicationId, claims, summary) {
    const current = this.getApplicationForUser(applicationId, userId);
    if (!current) return null;
    const timestamp = nowIso();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM application_claims WHERE application_id = ? AND user_id = ?').run(applicationId, userId);
      const statement = this.db.prepare('INSERT INTO application_claims (id, user_id, application_id, claim_order, claim_text, verdict, reason, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const claim of claims) statement.run(newId(), userId, applicationId, claim.claimOrder, claim.claimText, claim.verdict, claim.reason, JSON.stringify(claim.evidence || []), timestamp);
      this.db.prepare('UPDATE applications SET claim_summary_json = ?, stale = 0, stale_reason = \'\', updated_at = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(summary || {}), timestamp, applicationId, userId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getApplicationForUser(applicationId, userId);
  }

  getApplicationClaimsForUser(applicationId, userId) {
    return this.db.prepare('SELECT id, application_id, claim_order, claim_text, verdict, reason, evidence_json, created_at FROM application_claims WHERE application_id = ? AND user_id = ? ORDER BY claim_order').all(applicationId, userId).map((row) => ({ id: row.id, applicationId: row.application_id, claimOrder: row.claim_order, claimText: row.claim_text, verdict: row.verdict, reason: row.reason, evidence: storedJson(row.evidence_json, []), createdAt: row.created_at }));
  }

  saveOpportunityReportForUser(userId, opportunityId, value) {
    const timestamp = nowIso();
    const existing = this.db.prepare('SELECT id FROM opportunity_reports WHERE user_id = ? AND opportunity_id = ?').get(userId, opportunityId);
    if (existing) this.db.prepare('UPDATE opportunity_reports SET status = ?, provider = ?, report_json = ?, error_message = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(value.status, value.provider || '', JSON.stringify(value.report || {}), value.errorMessage || '', timestamp, existing.id, userId);
    else this.db.prepare('INSERT INTO opportunity_reports (id, user_id, opportunity_id, status, provider, report_json, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(newId(), userId, opportunityId, value.status, value.provider || '', JSON.stringify(value.report || {}), value.errorMessage || '', timestamp, timestamp);
    return this.getOpportunityReportForUser(opportunityId, userId);
  }

  getOpportunityReportForUser(opportunityId, userId) {
    const row = this.db.prepare('SELECT id, opportunity_id, status, provider, report_json, error_message, created_at, updated_at FROM opportunity_reports WHERE opportunity_id = ? AND user_id = ?').get(opportunityId, userId);
    return row ? { id: row.id, opportunityId: row.opportunity_id, status: row.status, provider: row.provider, report: storedJson(row.report_json, {}), errorMessage: row.error_message, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  jobRequirementsView(row) {
    if (!row) return null;
    return {
      id: row.id,
      opportunityId: row.opportunity_id,
      requirementsVersion: row.requirements_version,
      analystVersion: row.analyst_version,
      provider: row.provider,
      model: row.model,
      status: row.status,
      contentHash: row.content_hash,
      requirements: storedJson(row.requirements_json, {}),
      rawOutput: storedJson(row.raw_output_json, {}),
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getJobRequirementsByIdForUser(id, userId) {
    const row = this.db.prepare('SELECT id, opportunity_id, requirements_version, analyst_version, provider, model, status, content_hash, requirements_json, raw_output_json, error_message, created_at, updated_at FROM job_requirements WHERE id = ? AND user_id = ?').get(id, userId);
    return this.jobRequirementsView(row);
  }

  getLatestJobRequirementsForUser(opportunityId, userId, contentHash = '') {
    const row = this.db.prepare(`
      SELECT id, opportunity_id, requirements_version, analyst_version, provider, model, status, content_hash, requirements_json, raw_output_json, error_message, created_at, updated_at
      FROM job_requirements
      WHERE opportunity_id = ? AND user_id = ? AND status = 'READY' ${contentHash ? 'AND content_hash = ?' : ''}
      ORDER BY created_at DESC LIMIT 1
    `).get(...(contentHash ? [opportunityId, userId, contentHash] : [opportunityId, userId]));
    return this.jobRequirementsView(row);
  }

  listJobRequirementsForUser(opportunityId, userId) {
    return this.db.prepare('SELECT id, opportunity_id, requirements_version, analyst_version, provider, model, status, content_hash, requirements_json, raw_output_json, error_message, created_at, updated_at FROM job_requirements WHERE opportunity_id = ? AND user_id = ? ORDER BY created_at DESC').all(opportunityId, userId).map((row) => this.jobRequirementsView(row));
  }

  createJobRequirementsForUser(userId, value) {
    const id = newId();
    const timestamp = nowIso();
    this.db.exec('BEGIN');
    try {
      this.db.prepare("UPDATE job_requirements SET status = 'STALE', updated_at = ? WHERE opportunity_id = ? AND user_id = ? AND status = 'READY'").run(timestamp, value.opportunityId, userId);
      this.db.prepare(`
        INSERT INTO job_requirements (id, user_id, opportunity_id, requirements_version, analyst_version, provider, model, status, content_hash, requirements_json, raw_output_json, error_message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'READY', ?, ?, ?, '', ?, ?)
      `).run(id, userId, value.opportunityId, value.requirements.version, value.analystVersion, value.provider, value.model, value.contentHash, JSON.stringify(value.requirements), JSON.stringify(value.rawOutput || {}), timestamp, timestamp);
      this.db.exec('COMMIT');
      return this.getJobRequirementsByIdForUser(id, userId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createFailedJobRequirementsForUser(userId, value) {
    const id = newId();
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO job_requirements (id, user_id, opportunity_id, requirements_version, analyst_version, provider, model, status, content_hash, requirements_json, raw_output_json, error_message, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'FAILED', ?, '{}', '{}', ?, ?, ?)
    `).run(id, userId, value.opportunityId, value.requirementsVersion, value.analystVersion, value.provider || '', value.model || '', value.contentHash, value.errorMessage, timestamp, timestamp);
    return this.getJobRequirementsByIdForUser(id, userId);
  }

  matchResultView(row) {
    return {
      id: row.id,
      matchRunId: row.match_run_id,
      opportunityId: row.opportunity_id,
      requirementId: row.requirement_id,
      requirementType: row.requirement_type,
      priority: row.priority,
      requirementText: row.requirement_text,
      matchState: row.match_state,
      evidence: storedJson(row.evidence_json, []),
      reason: row.reason,
      createdAt: row.created_at,
    };
  }

  getMatchResultsForRunForUser(runId, userId) {
    return this.db.prepare('SELECT id, match_run_id, opportunity_id, requirement_id, requirement_type, priority, requirement_text, match_state, evidence_json, reason, created_at FROM match_results WHERE match_run_id = ? AND user_id = ? ORDER BY CASE priority WHEN \'REQUIRED\' THEN 0 ELSE 1 END, requirement_text COLLATE NOCASE').all(runId, userId).map((row) => this.matchResultView(row));
  }

  getMatchRunByIdForUser(runId, userId) {
    const row = this.db.prepare('SELECT id, user_id, opportunity_id, job_requirements_id, matcher_version, results_json, created_at FROM match_runs WHERE id = ? AND user_id = ?').get(runId, userId);
    if (!row) return null;
    return { id: row.id, opportunityId: row.opportunity_id, jobRequirementsId: row.job_requirements_id, matcherVersion: row.matcher_version, results: this.getMatchResultsForRunForUser(runId, userId), createdAt: row.created_at };
  }

  getLatestMatchRunForUser(opportunityId, userId) {
    const row = this.db.prepare('SELECT id FROM match_runs WHERE opportunity_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1').get(opportunityId, userId);
    return row ? this.getMatchRunByIdForUser(row.id, userId) : null;
  }

  createMatchRunForUser(userId, value) {
    const runId = newId();
    const timestamp = nowIso();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO match_runs (id, user_id, opportunity_id, job_requirements_id, matcher_version, results_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(runId, userId, value.opportunityId, value.jobRequirementsId, value.matcherVersion, JSON.stringify(value.results), timestamp);
      const statement = this.db.prepare('INSERT INTO match_results (id, user_id, match_run_id, opportunity_id, requirement_id, requirement_type, priority, requirement_text, match_state, evidence_json, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const result of value.results) statement.run(newId(), userId, runId, value.opportunityId, result.requirementId, result.requirementType, result.priority, result.requirementText, result.matchState, JSON.stringify(result.evidence || []), result.reason, timestamp);
      this.db.exec('COMMIT');
      return this.getMatchRunByIdForUser(runId, userId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  scoreBreakdownView(row) {
    if (!row) return null;
    return { id: row.id, opportunityId: row.opportunity_id, matchRunId: row.match_run_id, jobRequirementsId: row.job_requirements_id, formulaVersion: row.formula_version, ...storedJson(row.score_json, {}), overallScore: row.overall_score, createdAt: row.created_at };
  }

  getLatestScoreForUser(opportunityId, userId) {
    const row = this.db.prepare('SELECT id, opportunity_id, match_run_id, job_requirements_id, formula_version, score_json, overall_score, created_at FROM score_breakdowns WHERE opportunity_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1').get(opportunityId, userId);
    return this.scoreBreakdownView(row);
  }

  createScoreBreakdownForUser(userId, value) {
    const id = newId();
    const timestamp = nowIso();
    this.db.prepare('INSERT INTO score_breakdowns (id, user_id, opportunity_id, match_run_id, job_requirements_id, formula_version, score_json, overall_score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, userId, value.opportunityId, value.matchRunId, value.jobRequirementsId, value.formulaVersion, JSON.stringify(value.score), value.score.overallScore, timestamp);
    return this.getLatestScoreForUser(value.opportunityId, userId);
  }

  gapView(row) {
    return { id: row.id, opportunityId: row.opportunity_id, matchRunId: row.match_run_id, requirementId: row.requirement_id, priority: row.priority, gapState: row.gap_state, requirementText: row.requirement_text, currentEvidence: storedJson(row.current_evidence_json, []), missingCapability: row.missing_capability, explanation: row.explanation, nextAction: row.next_action, logicVersion: row.logic_version, createdAt: row.created_at };
  }

  getGapsForMatchRunForUser(runId, userId) {
    return this.db.prepare('SELECT id, opportunity_id, match_run_id, requirement_id, priority, gap_state, requirement_text, current_evidence_json, missing_capability, explanation, next_action, logic_version, created_at FROM gaps WHERE match_run_id = ? AND user_id = ? ORDER BY CASE priority WHEN \'REQUIRED\' THEN 0 ELSE 1 END, requirement_text COLLATE NOCASE').all(runId, userId).map((row) => this.gapView(row));
  }

  getLatestGapsForUser(opportunityId, userId) {
    const run = this.getLatestMatchRunForUser(opportunityId, userId);
    const gapRun = run && this.getGapRunForMatchRunForUser(run.id, userId);
    return gapRun ? this.getGapsForMatchRunForUser(run.id, userId) : null;
  }

  gapRunView(row) {
    if (!row) return null;
    return { id: row.id, opportunityId: row.opportunity_id, matchRunId: row.match_run_id, logicVersion: row.logic_version, gapCount: row.gap_count, createdAt: row.created_at };
  }

  getGapRunForMatchRunForUser(matchRunId, userId) {
    const row = this.db.prepare('SELECT id, opportunity_id, match_run_id, logic_version, gap_count, created_at FROM gap_runs WHERE match_run_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1').get(matchRunId, userId);
    return this.gapRunView(row);
  }

  getLatestGapRunForUser(opportunityId, userId) {
    const row = this.db.prepare('SELECT id, opportunity_id, match_run_id, logic_version, gap_count, created_at FROM gap_runs WHERE opportunity_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1').get(opportunityId, userId);
    return this.gapRunView(row);
  }

  createGapsForUser(userId, value) {
    const runId = newId();
    const timestamp = nowIso();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM gaps WHERE match_run_id = ? AND user_id = ?').run(value.matchRunId, userId);
      this.db.prepare('DELETE FROM gap_runs WHERE match_run_id = ? AND user_id = ?').run(value.matchRunId, userId);
      this.db.prepare('INSERT INTO gap_runs (id, user_id, opportunity_id, match_run_id, logic_version, gap_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(runId, userId, value.opportunityId, value.matchRunId, value.logicVersion, value.gaps.length, timestamp);
      const statement = this.db.prepare('INSERT INTO gaps (id, user_id, opportunity_id, match_run_id, requirement_id, priority, gap_state, requirement_text, current_evidence_json, missing_capability, explanation, next_action, logic_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const gap of value.gaps) statement.run(newId(), userId, value.opportunityId, value.matchRunId, gap.requirementId, gap.priority, gap.gapState, gap.requirementText, JSON.stringify(gap.currentEvidence || []), gap.missingCapability, gap.explanation, gap.nextAction || '', value.logicVersion, timestamp);
      this.db.exec('COMMIT');
      return { run: this.getGapRunForMatchRunForUser(value.matchRunId, userId), gaps: this.getGapsForMatchRunForUser(value.matchRunId, userId) };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getEvidenceLinksForUser(evidenceId, userId) {
    return this.db.prepare(`
      SELECT entity_type, entity_id, created_at
      FROM evidence_links
      WHERE evidence_id = ? AND user_id = ?
      ORDER BY entity_type, entity_id
    `).all(evidenceId, userId).map((link) => ({ entityType: link.entity_type, entityId: link.entity_id, createdAt: link.created_at }));
  }

  getEntityLabelForUser(entityType, entityId, userId) {
    const queries = {
      skill: 'SELECT id, name AS label FROM skills WHERE id = ? AND user_id = ?',
      project: 'SELECT id, name AS label FROM projects WHERE id = ? AND user_id = ?',
      experience: 'SELECT id, organization || \' — \' || role AS label FROM experience WHERE id = ? AND user_id = ?',
      education: 'SELECT id, institution || \' — \' || program AS label FROM education WHERE id = ? AND user_id = ?',
    };
    if (!queries[entityType]) return null;
    return this.db.prepare(queries[entityType]).get(entityId, userId) || null;
  }

  validateEvidenceLinksForUser(links, userId) {
    for (const [entityType, entityIds] of Object.entries(links || {})) {
      for (const entityId of entityIds || []) {
        if (!this.getEntityLabelForUser(entityType, entityId, userId)) {
          const error = new Error('Related record not found for this account.');
          error.code = 'INVALID_EVIDENCE_LINK';
          throw error;
        }
      }
    }
  }

  replaceEvidenceLinksForUser(evidenceId, userId, links) {
    this.validateEvidenceLinksForUser(links, userId);
    this.db.prepare('DELETE FROM evidence_links WHERE evidence_id = ? AND user_id = ?').run(evidenceId, userId);
    const statement = this.db.prepare(`
      INSERT INTO evidence_links (id, user_id, evidence_id, entity_type, entity_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const timestamp = nowIso();
    for (const [entityType, entityIds] of Object.entries(links || {})) {
      for (const entityId of entityIds || []) statement.run(newId(), userId, evidenceId, entityType, entityId, timestamp);
    }
    return this.getEvidenceLinksForUser(evidenceId, userId);
  }

  getEvidenceByIdForUser(id, userId) {
    const evidence = this.db.prepare(`
      SELECT id, title, description, evidence_type, status_context, source_type,
             source_title, source_reference, source_url, timeframe_start, timeframe_end,
             notes, created_at, updated_at
      FROM evidence WHERE id = ? AND user_id = ?
    `).get(id, userId);
    if (!evidence) return null;
    return { ...evidence, links: this.getEvidenceLinksForUser(id, userId) };
  }

  listEvidenceForUser(userId, filters = {}) {
    const conditions = ['e.user_id = ?'];
    const params = [userId];
    if (filters.query) {
      conditions.push(`(e.title LIKE ? OR e.description LIKE ? OR e.source_title LIKE ? OR e.source_reference LIKE ? OR e.notes LIKE ?)`);
      const query = `%${filters.query}%`;
      params.push(query, query, query, query, query);
    }
    if (filters.status) { conditions.push('e.status_context = ?'); params.push(filters.status); }
    if (filters.evidenceType) { conditions.push('e.evidence_type = ?'); params.push(filters.evidenceType); }
    for (const entityType of ['skill', 'project', 'experience', 'education']) {
      if (filters[`${entityType}Id`]) {
        conditions.push(`EXISTS (SELECT 1 FROM evidence_links filter_link WHERE filter_link.evidence_id = e.id AND filter_link.user_id = e.user_id AND filter_link.entity_type = ? AND filter_link.entity_id = ?)`);
        params.push(entityType, filters[`${entityType}Id`]);
      }
    }
    const rows = this.db.prepare(`
      SELECT e.id, e.title, e.description, e.evidence_type, e.status_context, e.source_type,
             e.source_title, e.source_reference, e.source_url, e.timeframe_start, e.timeframe_end,
             e.notes, e.created_at, e.updated_at
      FROM evidence e
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.updated_at DESC
    `).all(...params);
    return rows.map((evidence) => ({ ...evidence, links: this.getEvidenceLinksForUser(evidence.id, userId) }));
  }

  createEvidenceForUser(userId, value) {
    const id = newId();
    const timestamp = nowIso();
    this.db.exec('BEGIN');
    try {
      this.validateEvidenceLinksForUser(value.links, userId);
      this.db.prepare(`
        INSERT INTO evidence (id, user_id, title, description, evidence_type, status_context, source_type, source_title, source_reference, source_url, timeframe_start, timeframe_end, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, userId, value.title, value.description, value.evidenceType, value.status, value.sourceType, value.sourceTitle, value.sourceReference, value.sourceUrl, value.timeframeStart || null, value.timeframeEnd || null, value.notes, timestamp, timestamp);
      this.replaceEvidenceLinksForUser(id, userId, value.links);
      this.markAnalysesStaleForUser(userId);
      this.db.exec('COMMIT');
      return this.getEvidenceByIdForUser(id, userId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  updateEvidenceForUser(id, userId, value) {
    this.db.exec('BEGIN');
    try {
      this.validateEvidenceLinksForUser(value.links, userId);
      const result = this.db.prepare(`
        UPDATE evidence
        SET title = ?, description = ?, evidence_type = ?, status_context = ?, source_type = ?, source_title = ?, source_reference = ?, source_url = ?, timeframe_start = ?, timeframe_end = ?, notes = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(value.title, value.description, value.evidenceType, value.status, value.sourceType, value.sourceTitle, value.sourceReference, value.sourceUrl, value.timeframeStart || null, value.timeframeEnd || null, value.notes, nowIso(), id, userId);
      if (!result.changes) {
        this.db.exec('ROLLBACK');
        return null;
      }
      this.replaceEvidenceLinksForUser(id, userId, value.links);
      this.markAnalysesStaleForUser(userId);
      this.db.exec('COMMIT');
      return this.getEvidenceByIdForUser(id, userId);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deleteEvidenceForUser(id, userId) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM evidence_links WHERE evidence_id = ? AND user_id = ?').run(id, userId);
      const deleted = this.db.prepare('DELETE FROM evidence WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
      if (deleted) this.markAnalysesStaleForUser(userId);
      this.db.exec('COMMIT');
      return deleted;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createAuditEvent({ userId, action, metadata = {} }) {
    this.db.prepare(`
      INSERT INTO audit_events (id, user_id, action, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(newId(), userId, action, JSON.stringify(metadata), nowIso());
  }

  listAuditEventsForUser(userId, limit = 100) {
    return this.db.prepare(`
      SELECT id, action, metadata_json, created_at
      FROM audit_events WHERE user_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(userId, Math.min(Math.max(Number(limit) || 100, 1), 100)).map((event) => ({
      id: event.id,
      action: event.action,
      metadata: JSON.parse(event.metadata_json),
      createdAt: event.created_at,
    }));
  }
}

module.exports = { AppDatabase };
