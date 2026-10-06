const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { AppDatabase } = require('./db');
const {
  hashPassword,
  hashToken,
  isValidEmail,
  normalizeEmail,
  randomToken,
  safeEqualText,
  validatePassword,
  verifyPassword,
} = require('./security');
const {
  CURRENT_STATUSES,
  ONBOARDING_STEPS,
  SKILL_STATUSES,
  completionState,
  parseJsonList,
  validateEducation,
  validateExperience,
  validateProfile,
  validateProject,
  validateSkill,
} = require('./profile');
const {
  EVIDENCE_STATUSES,
  EVIDENCE_TYPES,
  LINK_TYPES,
  SOURCE_TYPES,
  validateEvidence,
} = require('./evidence');
const {
  OPPORTUNITY_SOURCES,
  OPPORTUNITY_STATUSES,
  MAX_DESCRIPTION_LENGTH,
  toOpportunityPayload,
} = require('./opportunity');
const {
  ANALYST_VERSION,
  AnalystOutputError,
  AnalystProviderError,
  JOB_REQUIREMENTS_VERSION,
  JobAnalyst,
  validateJobRequirements,
} = require('./jobAnalyst');
const { matchRequirements, MATCHER_VERSION } = require('./matcher');
const { scoreMatchResults, SCORE_FORMULA_VERSION } = require('./scoring');
const { analyzeGaps, GAP_LOGIC_VERSION } = require('./gaps');
const { buildSearchQueries, normalizeDiscoveryResult, profileView: discoveryProfileView, resultList } = require('./discovery');
const { runAutomaticAnalysis } = require('./pipeline');
const { buildAndSaveReport, getReportFreshness } = require('./report');
const { APPLICATION_STATUSES, applicationFreshness, applicationSourceSnapshot, buildApplicationDraft, groundClaims, summarizeClaims } = require('./application');
const { ROADMAP_STATUSES, roadmapForGaps } = require('./roadmap');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const BODY_LIMIT = 1_048_576;
const SESSION_COOKIE = 'cc_session';
const CSRF_COOKIE = 'cc_csrf';
const DUMMY_PASSWORD_HASH = hashPassword('not-a-real-password-for-timing-only');

const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const clientScript = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]));
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf('=');
    if (separator === -1) return [part, ''];
    return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
  }));
}

function cookie(name, value, { maxAge, httpOnly = false, secure }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function deletedCookie(name, secure) {
  return cookie(name, '', { maxAge: 0, httpOnly: name === SESSION_COOKIE, secure });
}

function securityHeaders({ secure }) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
  if (secure) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, body, extraHeaders = {}, config) {
  send(res, status, JSON.stringify(body), {
    ...securityHeaders(config),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
}

function sendHtml(res, status, body, extraHeaders = {}, config) {
  send(res, status, body, {
    ...securityHeaders(config),
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
}

function redirect(res, location, config, extraHeaders = {}) {
  send(res, 302, '', { ...securityHeaders(config), 'Cache-Control': 'no-store', Location: location, ...extraHeaders });
}

function isJsonRequest(req) {
  return (req.headers['content-type'] || '').includes('application/json') ||
    (req.headers.accept || '').includes('application/json');
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('application/json')) return resolve(JSON.parse(body));
        const params = new URLSearchParams(body);
        const parsed = {};
        for (const [key, value] of params) {
          const normalizedKey = key.endsWith('[]') ? key.slice(0, -2) : key;
          if (key.endsWith('[]')) {
            if (!Array.isArray(parsed[normalizedKey])) parsed[normalizedKey] = [];
            parsed[normalizedKey].push(value);
          } else {
            parsed[normalizedKey] = value;
          }
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('Invalid request body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function getQuery(req) {
  return new URL(req.url, 'http://localhost').searchParams;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const candidate = origin || referer;
  if (!candidate) return true;
  try {
    return new URL(candidate).host === req.headers.host;
  } catch {
    return false;
  }
}

function publicUser(user) {
  return { id: user.id, email: user.email, createdAt: user.created_at || user.createdAt };
}

function layout({ title, body, principal, csrf, active, publicNav = false }) {
  const nav = principal ? `
    <header class="topbar">
      <a class="brand" href="/dashboard">Career Commander</a>
      <nav aria-label="Primary navigation">
        ${[['dashboard', 'Dashboard', '/dashboard'], ['profile', 'Profile', '/profile'], ['discover', 'Discover', '/discover'], ['opportunities', 'Opportunities', '/opportunities'], ['applications', 'Applications', '/applications'], ['settings', 'Settings', '/settings']].map(([item, label, href]) => {
          return `<a class="nav-link ${active === item ? 'active' : ''}" href="${href}">${label}</a>`;
        }).join('')}
      </nav>
      <details class="account-menu">
        <summary>${escapeHtml(principal.email)}</summary>
        <div class="account-menu-panel">
          <a href="/settings">Account settings</a>
          ${csrf ? `<form method="post" action="/api/auth/logout">${hidden('csrf', csrf)}<button class="menu-action" type="submit">Log out</button></form>` : ''}
        </div>
      </details>
    </header>` : publicNav ? `
    <header class="topbar public-topbar">
      <a class="brand" href="/">Career Commander</a>
      <nav aria-label="Public navigation">
        <a class="nav-link" href="/#how-it-works">How it works</a>
        <a class="nav-link" href="/#evidence-story">Evidence</a>
      </nav>
      <div class="public-actions"><a class="nav-link" href="/login">Sign in</a><a class="button" href="/signup">Get started</a></div>
    </header>` : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} | Career Commander</title>
    <link rel="stylesheet" href="/styles.css">
    <script src="/app.js" defer></script>
  </head>
  <body>
    ${nav}
    <main class="page">${body}</main>
  </body>
</html>`;
}

function landingPetals() {
  const petals = [
    ['8%', '0s', '17s', '1.4rem', '1.8rem', '-18deg'], ['22%', '4s', '20s', '1.1rem', '1.5rem', '26deg'],
    ['36%', '9s', '19s', '.9rem', '1.3rem', '-42deg'], ['51%', '2s', '23s', '1.3rem', '1.7rem', '12deg'],
    ['67%', '12s', '18s', '.8rem', '1.2rem', '48deg'], ['78%', '6s', '22s', '1.2rem', '1.6rem', '-30deg'],
    ['91%', '15s', '20s', '.9rem', '1.4rem', '18deg'], ['14%', '19s', '24s', '.7rem', '1.1rem', '-8deg'],
    ['45%', '17s', '21s', '1rem', '1.5rem', '58deg'], ['59%', '21s', '25s', '.7rem', '1.2rem', '-50deg'],
    ['84%', '24s', '19s', '1.1rem', '1.5rem', '34deg'], ['29%', '27s', '23s', '.8rem', '1.3rem', '-20deg'],
  ];
  return petals.map(([x, delay, duration, size, drift, rotate]) => `<span class="landing-petal" style="--petal-x:${x};--petal-delay:${delay};--petal-duration:${duration};--petal-size:${size};--petal-drift:${drift};--petal-rotate:${rotate}" aria-hidden="true"></span>`).join('');
}

function landingTree() {
  return `<div class="landing-tree" aria-hidden="true"><svg viewBox="0 0 900 640" role="presentation" focusable="false">
    <path class="tree-trunk" d="M747 650 C730 567 724 493 738 415 C752 334 790 255 825 170 C846 119 849 72 844 0" />
    <path class="tree-branch" d="M748 432 C677 385 594 344 501 326 C399 306 272 316 87 269" />
    <path class="tree-branch fine" d="M698 397 C624 319 554 255 459 219 C364 183 244 177 119 132" />
    <path class="tree-branch" d="M746 357 C679 294 629 214 603 123 C586 65 569 30 536 0" />
    <path class="tree-branch fine" d="M654 340 C576 343 495 370 414 424 C350 467 264 493 158 495" />
    <path class="tree-branch fine" d="M768 282 C716 218 690 133 692 42" />
    <g class="tree-blossoms">
      <circle cx="92" cy="268" r="8" /><circle cx="143" cy="284" r="6" /><circle cx="211" cy="295" r="9" /><circle cx="286" cy="304" r="6" />
      <circle cx="121" cy="134" r="7" /><circle cx="185" cy="154" r="9" /><circle cx="253" cy="170" r="6" /><circle cx="351" cy="194" r="8" />
      <circle cx="536" cy="16" r="8" /><circle cx="570" cy="78" r="6" /><circle cx="594" cy="129" r="9" /><circle cx="603" cy="215" r="6" />
      <circle cx="158" cy="495" r="7" /><circle cx="239" cy="481" r="9" /><circle cx="329" cy="454" r="6" /><circle cx="415" cy="422" r="8" />
      <circle cx="692" cy="48" r="7" /><circle cx="694" cy="121" r="9" /><circle cx="717" cy="205" r="6" /><circle cx="786" cy="196" r="8" />
    </g>
  </svg></div>`;
}

function landingPage({ principal = null, csrf = '' }) {
  const finalAction = principal ? '<a class="button" href="/dashboard">Open dashboard</a>' : '<a class="button" href="/signup">Get started</a>';
  return layout({
    title: 'Career intelligence grounded in evidence', principal, csrf, publicNav: !principal,
    body: `<div class="landing-page">
      <section class="landing-hero" aria-labelledby="landing-title"><div class="landing-petals">${landingPetals()}</div>${landingTree()}<div class="landing-hero-copy"><p class="eyebrow">CAREER COMMANDER</p><h1 id="landing-title">Your career.<br>Backed by evidence.</h1><p class="landing-lead">Career Commander turns job descriptions and your actual experience into an explainable fit assessment, evidence-backed application drafts, and a clear path to close the gaps.</p><div class="actions"><a class="button" href="${principal ? '/dashboard' : '/signup'}">Get started</a><a class="button secondary" href="#how-it-works">See how it works</a></div>${principal ? '<p class="landing-login">You are signed in. <a href="/dashboard">Continue to your workspace</a>.</p>' : '<p class="landing-login">Already have an account? <a href="/login">Sign in</a>.</p>'}</div></section>

      <section class="landing-section problem-section" id="problem" aria-labelledby="problem-title"><div class="section-kicker">The problem</div><div class="section-copy"><h2 id="problem-title">Convincing text is not the same as a supported claim.</h2><p>Most AI career tools optimize the output. A fluent application can still overstate what a candidate has done, learned, or can prove.</p><p>Career Commander starts with the evidence behind the output. It keeps profile declarations, source material, decisions, and human approval distinct.</p></div><div class="editorial-statement"><span>Most tools optimize the output.</span><strong>Career Commander optimizes the evidence behind it.</strong></div></section>

      <section class="landing-section difference-section" id="how-it-works" aria-labelledby="difference-title"><div class="section-kicker">The Career Commander difference</div><div class="section-copy"><h2 id="difference-title">Each part has a defined responsibility.</h2><p>AI helps interpret and draft. Deterministic code makes the decisions that should be inspectable. You remain the final reviewer.</p></div><div class="rule-chain" aria-label="Career Commander responsibility model"><div class="rule-step"><span>AI</span><strong>Interpret</strong><small>Understand job language and help shape drafts.</small></div><div class="rule-line" aria-hidden="true"></div><div class="rule-step"><span>Code</span><strong>Decide and check</strong><small>Match requirements, calculate rules-based results, and check claims.</small></div><div class="rule-line" aria-hidden="true"></div><div class="rule-step"><span>Human</span><strong>Approve</strong><small>Review the evidence and decide what goes out.</small></div></div></section>

      <section class="landing-section pipeline-section" aria-labelledby="pipeline-title"><div class="section-kicker">The pipeline</div><div class="section-copy"><h2 id="pipeline-title">From a job posting to a reviewed application.</h2><p>One connected path keeps every later decision tied to something concrete.</p></div><ol class="pipeline-list"><li><span>01</span><strong>Bring in a job</strong><small>Start with a posting you want to understand.</small></li><li><span>02</span><strong>Structure requirements</strong><small>Separate required, preferred, and contextual signals.</small></li><li><span>03</span><strong>Compare real evidence</strong><small>Ask what your profile and sources actually support.</small></li><li><span>04</span><strong>Calculate an explainable result</strong><small>Use deterministic match and scoring rules.</small></li><li><span>05</span><strong>Identify gaps</strong><small>Make missing proof visible without overstating readiness.</small></li><li><span>06</span><strong>Build evidence-producing tasks</strong><small>Turn a gap into work that can create useful proof.</small></li><li><span>07</span><strong>Draft an application</strong><small>Use supported material as the writing source.</small></li><li><span>08</span><strong>Check each claim</strong><small>Trace sentences back to evidence before review.</small></li><li><span>09</span><strong>Review before applying</strong><small>The candidate remains the final decision-maker.</small></li></ol></section>

      <section class="landing-section evidence-story" id="evidence-story" aria-labelledby="evidence-title"><div class="section-kicker">Evidence has context</div><div class="section-copy"><h2 id="evidence-title">Learning does not silently become experience.</h2><p>These are conceptual examples of the distinctions Career Commander is designed to preserve. They are not a real user profile.</p></div><div class="evidence-example"><div class="example-row"><span class="status-marker status-good" aria-hidden="true"></span><strong>Django</strong><span>VERIFIED</span><small>Supported by an explicit source.</small></div><div class="example-row"><span class="status-marker status-learning" aria-hidden="true"></span><strong>AWS</strong><span>LEARNING</span><small>Useful context, not production experience.</small></div><div class="example-row"><span class="status-marker status-none" aria-hidden="true"></span><strong>TypeScript</strong><span>NO EVIDENCE</span><small>A declaration without a supporting source.</small></div></div><div class="evidence-callout"><strong>AWS — Required</strong><span>Current state: Learning</span><em>Result: Partial</em></div></section>

      <section class="landing-section score-section" aria-labelledby="score-title"><div class="section-kicker">Deterministic scoring</div><div class="section-copy"><h2 id="score-title">A result you can inspect.</h2><p>When a job exists, a future analysis can show how structured requirement matches produce a score. The number is an output of rules, not a mood or a model's confidence.</p></div><div class="score-example"><div><span>Conceptual example</span><strong>3 of 4 required requirements matched</strong></div><dl><div><dt>Required</dt><dd>75%</dd></div><div><dt>Preferred</dt><dd>50%</dd></div><div><dt>Overall</dt><dd>67.5</dd></div></dl></div></section>

      <section class="landing-section claims-section" aria-labelledby="claims-title"><div class="section-kicker">Claim verification</div><div class="section-copy"><h2 id="claims-title">Make the sentence earn its place.</h2><p>A claim should be as precise as the evidence behind it. These examples show the difference between an unsupported statement and a defensible one.</p></div><div class="claim-grid"><article class="claim-case"><p class="claim-label">Conceptual example</p><blockquote>“I have production AWS experience.”</blockquote><strong class="claim-verdict unsupported">Unsupported</strong><p>Evidence says AWS is currently marked Learning.</p></article><article class="claim-case"><p class="claim-label">Conceptual example</p><blockquote>“I am currently building AWS deployment experience.”</blockquote><strong class="claim-verdict supported">Supported</strong><p>The wording matches the available context without adding a production claim.</p></article></div></section>

      <section class="landing-section review-section" aria-labelledby="review-title"><div class="section-kicker">Human review</div><div class="section-copy"><h2 id="review-title">AI can help prepare the application. You decide whether it goes out.</h2><p>Career Commander does not apply for you automatically. A draft is ready for human review only when its supporting evidence and claim-level checks are visible.</p></div><div class="review-line"><span>Draft prepared</span><span>Claims checked</span><strong>Ready for human review</strong></div></section>

      <section class="landing-section walkthrough-section" aria-labelledby="walkthrough-title"><div class="section-kicker">Product walkthrough</div><div class="section-copy"><h2 id="walkthrough-title">One record, carried through the work.</h2><p>Future product surfaces will connect these stages. The current product establishes the profile and Evidence Locker that later stages depend on.</p></div><div class="walkthrough-list"><div><span>01</span><strong>Opportunity</strong></div><div><span>02</span><strong>Analysis</strong></div><div><span>03</span><strong>Evidence</strong></div><div><span>04</span><strong>Score</strong></div><div><span>05</span><strong>Gaps</strong></div><div><span>06</span><strong>Draft</strong></div><div><span>07</span><strong>Verification</strong></div><div><span>08</span><strong>Review</strong></div></div></section>

      <section class="landing-section discovery-section" aria-labelledby="discovery-title"><div class="section-kicker">Opportunity intake</div><div class="section-copy"><h2 id="discovery-title">Bring opportunities in from the sources you use.</h2><p>Internet, email, and manual entry can eventually feed one normalized opportunity pipeline. The source may differ; the analysis boundary should not.</p></div><div class="source-list"><div><strong>Internet</strong><span>Planned source</span></div><div><strong>Email</strong><span>Planned source</span></div><div><strong>Manual</strong><span>Available as a future direct-entry path</span></div></div></section>

      <section class="landing-section growth-section" aria-labelledby="growth-title"><div class="section-kicker">Evidence to growth</div><div class="section-copy"><h2 id="growth-title">Turn a gap into work that creates proof.</h2><p>A useful roadmap does more than recommend a topic. It points toward an artifact that can close the evidence gap.</p></div><div class="growth-chain"><div><span>Gap</span><strong>AWS production evidence</strong></div><div class="growth-arrow" aria-hidden="true">↓</div><div><span>Task</span><strong>Deploy an existing Django/PostgreSQL project to AWS</strong></div><div class="growth-arrow" aria-hidden="true">↓</div><div><span>New evidence</span><strong>Architecture, deployment, and documentation</strong></div></div></section>

      <section class="landing-final" aria-labelledby="final-title"><p class="eyebrow">CAREER COMMANDER</p><h2 id="final-title">Build your evidence base.<br>Then apply with it.</h2><p>Start with the facts you can stand behind.</p><div class="actions">${finalAction}<a class="button secondary" href="${principal ? '/settings' : '/login'}">${principal ? 'Account settings' : 'Sign in'}</a></div></section>
    </div>`,
  });
}

function authForm({ type, csrf, message = '', next = '' }) {
  const login = type === 'login';
  return layout({
    title: login ? 'Log in' : 'Create account',
    body: `<section class="auth-card">
      <p class="eyebrow">CAREER COMMANDER</p>
      <h1>${login ? 'Return to your evidence-backed career plan.' : 'Create your Career Commander account.'}</h1>
      <p class="muted">${login ? 'Your profile, evidence, and applications stay private to your account.' : 'Start with a private workspace for your career evidence and opportunities.'}</p>
      ${message ? `<p class="message error" role="alert">${escapeHtml(message)}</p>` : ''}
      <form method="post" action="/api/auth/${login ? 'login' : 'signup'}" class="stack">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        ${next ? `<input type="hidden" name="next" value="${escapeHtml(next)}">` : ''}
        <label>Email<input type="email" name="email" autocomplete="email" required></label>
        <label>Password<input type="password" name="password" autocomplete="${login ? 'current-password' : 'new-password'}" minlength="12" required></label>
        <button type="submit">${login ? 'Log in' : 'Create account'}</button>
      </form>
      ${login ? '<p class="form-link"><a href="/password-reset">Forgot your password?</a></p><p class="form-link">New here? <a href="/signup">Create an account</a></p>' : '<p class="form-link">Already have an account? <a href="/login">Log in</a></p>'}
    </section>`,
  });
}

function resetPage({ csrf, token = '', message = '', sent = false }) {
  const confirming = Boolean(token);
  return layout({
    title: 'Password reset',
    body: `<section class="auth-card">
      <p class="eyebrow">ACCOUNT ACCESS</p>
      <h1>${confirming ? 'Choose a new password.' : 'Reset your password.'}</h1>
      <p class="muted">${confirming ? 'This link can be used once and expires after one hour.' : 'Enter your email and we will begin a secure reset.'}</p>
      ${message ? `<p class="message ${sent ? 'success' : 'error'}" role="status">${escapeHtml(message)}</p>` : ''}
      ${confirming ? `<form method="post" action="/api/auth/password-reset/confirm" class="stack">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <label>New password<input type="password" name="password" autocomplete="new-password" minlength="12" required></label>
        <button type="submit">Set new password</button>
      </form>` : `<form method="post" action="/api/auth/password-reset/request" class="stack">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <label>Email<input type="email" name="email" autocomplete="email" required></label>
        <button type="submit">Send reset instructions</button>
      </form>`}
      <p class="form-link"><a href="/login">Return to log in</a></p>
    </section>`,
  });
}

function protectedPage({ title, active, principal, csrf, description, nextAction }) {
  return layout({
    title,
    active,
    principal,
    csrf,
    body: `<section class="content-card">
      <p class="eyebrow">AUTHENTICATED WORKSPACE</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="lead">${escapeHtml(description)}</p>
      <div class="boundary-note"><strong>Phase 2 boundary verified.</strong><span>${escapeHtml(nextAction)}</span></div>
      <p class="muted">Signed in as ${escapeHtml(principal.email)}. Domain workflow data will be added only through this authenticated ownership boundary.</p>
    </section>`,
  });
}

function settingsPage({ principal, csrf, message = '' }) {
  return layout({
    title: 'Settings', active: 'settings', principal, csrf,
    body: `<section class="content-card">
      <p class="eyebrow">ACCOUNT SETTINGS</p>
      <h1>Keep your account secure.</h1>
      <p class="lead">Manage the identity and sessions that protect your Career Commander workspace.</p>
      ${message ? `<p class="message success" role="status">${escapeHtml(message)}</p>` : ''}
      <div class="settings-grid">
        <div><h2>Account</h2><p class="muted">${escapeHtml(principal.email)}</p></div>
        <div><h2>Change password</h2>
          <form method="post" action="/api/settings/password" class="stack">
            <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
            <label>Current password<input type="password" name="currentPassword" autocomplete="current-password" required></label>
            <label>New password<input type="password" name="newPassword" autocomplete="new-password" minlength="12" required></label>
            <button type="submit">Change password</button>
          </form>
        </div>
        <div><h2>Sessions</h2><p class="muted">Changing your password signs out every other session.</p>
          <form method="post" action="/api/auth/logout"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="secondary" type="submit">Log out</button></form>
        </div>
      </div>
    </section>`,
  });
}

function field(label, name, value = '', { type = 'text', required = false, placeholder = '', description = '' } = {}) {
  const multiline = type === 'textarea';
  const control = multiline
    ? `<textarea name="${name}" rows="4"${required ? ' required' : ''} placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>`
    : `<input type="${type}" name="${name}" value="${escapeHtml(value)}"${required ? ' required' : ''} placeholder="${escapeHtml(placeholder)}">`;
  if (name === 'provider') return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  return `<label>${escapeHtml(label)}${required ? ' <span class="required">Required</span>' : ' <span class="optional">Optional</span>'}${control}${description ? `<small>${escapeHtml(description)}</small>` : ''}</label>`;
}

function hidden(name, value) {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}

function formButton(action, csrf, label, { className = '', extra = '' } = {}) {
  return `<form method="post" action="${escapeHtml(action)}" class="inline-form">${hidden('csrf', csrf)}${extra}<button class="${className}" type="submit">${escapeHtml(label)}</button></form>`;
}

function profileView(profile) {
  return {
    ...profile,
    targetRoles: parseJsonList(profile.target_roles_json),
    currentStatus: profile.current_status || '',
    completionState: completionState(profile),
  };
}

function educationView(record) {
  return { ...record, field: record.field_of_study || '', startDate: record.start_date || '', endDate: record.end_date || '' };
}

function projectView(record) {
  return { ...record, technologies: parseJsonList(record.technologies_json), roleContribution: record.role_contribution || '', timeframeStart: record.timeframe_start || '', timeframeEnd: record.timeframe_end || '', repositoryUrl: record.repository_url || '', demoUrl: record.demo_url || '', associatedEvidence: record.associated_evidence || '' };
}

function experienceView(record) {
  return { ...record, startDate: record.start_date || '', endDate: record.end_date || '', responsibilities: parseJsonList(record.responsibilities_json), technologies: parseJsonList(record.technologies_json), evidenceReference: record.evidence_reference || '' };
}

function statusOptions(current, statuses) {
  return statuses.map((status) => `<option value="${escapeHtml(status)}"${current === status ? ' selected' : ''}>${escapeHtml(status.replaceAll('_', ' '))}</option>`).join('');
}

function profileForm({ profile, csrf, action = '/api/profile', next = '', submit = 'Save profile' }) {
  return `<form method="post" action="${escapeHtml(action)}" class="stack form-section">
    ${hidden('csrf', csrf)}${next ? hidden('next', next) : ''}
    ${field('Name', 'name', profile.name, { required: true, description: 'Used to identify your career evidence base.' })}
    ${field('Target role(s)', 'targetRoles', profile.targetRoles.join(', '), { description: 'Roles you want future job analyses to compare against.' })}
    ${field('Location', 'location', profile.location, { description: 'Only include what helps evaluate opportunity fit.' })}
    <label>Current status <span class="optional">Optional</span><select name="currentStatus"><option value="">Choose a status</option>${statusOptions(profile.currentStatus, CURRENT_STATUSES)}</select></label>
    ${field('Professional summary', 'summary', profile.summary, { type: 'textarea', description: 'A concise working context for future drafts; it is not evidence by itself.' })}
    <button type="submit">${escapeHtml(submit)}</button>
  </form>`;
}

function educationForm({ record = {}, csrf, action = '/api/education', next = '', submit = 'Save education' }) {
  return `<form method="post" action="${escapeHtml(action)}" class="stack record-form">
    ${hidden('csrf', csrf)}${next ? hidden('next', next) : ''}
    ${field('Institution', 'institution', record.institution, { required: true })}
    ${field('Degree or program', 'program', record.program, { required: true })}
    ${field('Field', 'field', record.field)}
    <div class="two-column">${field('Start date', 'startDate', record.startDate, { type: 'date' })}${field('End date / expected completion', 'endDate', record.endDate, { type: 'date' })}</div>
    ${field('Description', 'description', record.description, { type: 'textarea', description: 'Context only; education does not verify technology experience.' })}
    ${hidden('recordId', record.id || '')}<button type="submit">${escapeHtml(submit)}</button>
  </form>`;
}

function skillForm({ record = {}, csrf, action = '/api/skills', next = '', submit = 'Save skill' }) {
  return `<form method="post" action="${escapeHtml(action)}" class="stack record-form">
    ${hidden('csrf', csrf)}${next ? hidden('next', next) : ''}
    ${field('Skill name', 'name', record.name, { required: true, description: 'A declaration until linked to concrete evidence.' })}
    <label>Status <span class="required">Required</span><select name="status" required>${statusOptions(record.status || 'NO_EVIDENCE', SKILL_STATUSES)}</select></label>
    ${field('Supporting evidence/reference', 'supportingReference', record.supporting_reference || record.supportingReference, { description: 'Required for VERIFIED. Use a project, work result, or source reference.' })}
    ${field('Description', 'description', record.description, { type: 'textarea' })}
    ${hidden('recordId', record.id || '')}<button type="submit">${escapeHtml(submit)}</button>
  </form>`;
}

function projectForm({ record = {}, csrf, action = '/api/projects', next = '', submit = 'Save project' }) {
  return `<form method="post" action="${escapeHtml(action)}" class="stack record-form">
    ${hidden('csrf', csrf)}${next ? hidden('next', next) : ''}
    ${field('Project name', 'name', record.name, { required: true })}
    ${field('Description', 'description', record.description, { type: 'textarea', required: true, description: 'Describe what was built and why; do not invent outcomes.' })}
    ${field('Technologies', 'technologies', (record.technologies || []).join(', '), { description: 'Comma-separated declarations; not automatically verified.' })}
    ${field('Role / contribution', 'roleContribution', record.roleContribution)}
    <div class="two-column">${field('From', 'timeframeStart', record.timeframeStart, { type: 'date' })}${field('To', 'timeframeEnd', record.timeframeEnd, { type: 'date' })}</div>
    <div class="two-column">${field('Repository URL', 'repositoryUrl', record.repositoryUrl, { type: 'url' })}${field('Demo URL', 'demoUrl', record.demoUrl, { type: 'url' })}</div>
    ${field('Outcome', 'outcome', record.outcome, { type: 'textarea', description: 'Optional measurable result or learning outcome.' })}
    ${field('Associated evidence/reference', 'associatedEvidence', record.associatedEvidence, { type: 'textarea', description: 'A traceable source for future application claims.' })}
    ${hidden('recordId', record.id || '')}<button type="submit">${escapeHtml(submit)}</button>
  </form>`;
}

function experienceForm({ record = {}, csrf, action = '/api/experience', next = '', submit = 'Save experience' }) {
  return `<form method="post" action="${escapeHtml(action)}" class="stack record-form">
    ${hidden('csrf', csrf)}${next ? hidden('next', next) : ''}
    ${field('Organization', 'organization', record.organization, { required: true })}
    ${field('Role', 'role', record.role, { required: true })}
    <div class="two-column">${field('Start date', 'startDate', record.startDate, { type: 'date' })}${field('End date', 'endDate', record.endDate, { type: 'date' })}</div>
    ${field('Description', 'description', record.description, { type: 'textarea' })}
    ${field('Responsibilities', 'responsibilities', (record.responsibilities || []).join(', '), { description: 'Comma-separated responsibilities, not inferred employment history.' })}
    ${field('Technologies', 'technologies', (record.technologies || []).join(', '), { description: 'Technologies used in this role; not automatically production-verified.' })}
    ${field('Evidence/reference', 'evidenceReference', record.evidenceReference, { type: 'textarea', description: 'A result, artifact, or source that can support future claims.' })}
    ${hidden('recordId', record.id || '')}<button type="submit">${escapeHtml(submit)}</button>
  </form>`;
}

function editableRecordList(records, render, csrf, collection, label, next = '') {
  if (!records.length) return `<p class="muted">No ${escapeHtml(label)} recorded yet.</p>`;
  return `<div class="record-list">${records.map((record) => `<details class="record-item"><summary>${escapeHtml(record.name || record.program || record.role || record.organization)}</summary>${render(record)}${formButton(`/api/${collection}/${record.id}/delete`, csrf, `Delete ${label}`, { className: 'danger-button', extra: next ? hidden('next', next) : '' })}</details>`).join('')}</div>`;
}

function profilePage({ principal, csrf, profile, education, skills, projects, experience, message = '' }) {
  const view = profileView(profile);
  return layout({
    title: 'Profile', active: 'profile', principal, csrf,
    body: `<section class="content-card wide-card">
      <p class="eyebrow">CAREER EVIDENCE BASE</p>
      <h1>Build the facts future analysis can use.</h1>
      <p class="lead">Keep profile context separate from evidence. A declaration can guide analysis without becoming a verified claim.</p>
      ${message ? `<p class="message ${message.startsWith('Saved') ? 'success' : 'error'}" role="status">${escapeHtml(message)}</p>` : ''}
      <div class="profile-state"><strong>${escapeHtml(view.completionState.replace('_', ' '))}</strong><span>Onboarding step: ${escapeHtml(view.onboarding_step)}</span></div>
      <h2>Profile essentials</h2><p class="form-link"><a href="/evidence">Open the Evidence Locker</a></p>${profileForm({ profile: view, csrf })}
      <section class="form-section"><h2>Education</h2><p class="section-note">Relevant education provides context. It does not automatically verify skills or technology experience.</p>${editableRecordList(education.map(educationView), (record) => educationForm({ record, csrf, action: `/api/education/${record.id}`, submit: 'Update education' }), csrf, 'education', 'education')}<h3>Add education</h3>${educationForm({ csrf })}</section>
      <section class="form-section"><h2>Skills</h2><p class="section-note">Only explicitly marked VERIFIED skills with a supporting reference appear as verified. A name alone is never enough.</p>${editableRecordList(skills, (record) => skillForm({ record, csrf, action: `/api/skills/${record.id}`, submit: 'Update skill' }), csrf, 'skills', 'skills')}<h3>Add skill</h3>${skillForm({ csrf })}</section>
      <section class="form-section"><h2>Projects</h2><p class="section-note">Projects are future evidence sources, not portfolio decoration.</p>${editableRecordList(projects.map(projectView), (record) => projectForm({ record, csrf, action: `/api/projects/${record.id}`, submit: 'Update project' }), csrf, 'projects', 'projects')}<h3>Add project</h3>${projectForm({ csrf })}</section>
      <section class="form-section"><h2>Experience</h2><p class="section-note">Record only real experience. Technology mentions do not imply production experience.</p>${editableRecordList(experience.map(experienceView), (record) => experienceForm({ record, csrf, action: `/api/experience/${record.id}`, submit: 'Update experience' }), csrf, 'experience', 'experience')}<h3>Add experience</h3>${experienceForm({ csrf })}</section>
    </section>`,
  });
}

function evidenceSummary(skills) {
  const groups = Object.fromEntries(SKILL_STATUSES.map((status) => [status, skills.filter((skill) => skill.status === status).map((skill) => skill.name)]));
  return `<div class="evidence-summary"><h2>Your evidence base</h2>${SKILL_STATUSES.map((status) => `<section class="status-row status-${status.toLowerCase()}"><span class="status-marker" aria-hidden="true"></span><h3>${escapeHtml(status.replace('_', ' '))}</h3><p>${groups[status].length ? groups[status].map(escapeHtml).join(', ') : 'None recorded yet.'}</p></section>`).join('')}</div>`;
}

function onboardingPage({ principal, csrf, step, profile, education, skills, projects, experience, message = '' }) {
  const view = profileView(profile);
  const stepIndex = ONBOARDING_STEPS.indexOf(step);
  const steps = ONBOARDING_STEPS.slice(1, -1);
  let content = '';
  if (step === 'welcome') {
    content = `<p class="lead">Career Commander starts with a practical evidence base: the context you want analyzed, the work you can point to, and the areas still being developed.</p><div class="boundary-note"><strong>This is progressive.</strong><span>You can skip optional sections, save partial work, and return from the dashboard.</span></div>${formButton('/api/onboarding', csrf, 'Start profile', { extra: hidden('step', 'profile') })}`;
  } else if (step === 'profile') {
    content = `<p class="lead">Start with the minimum context needed to make later job analysis relevant. Education is optional and remains separate from verified skills.</p>${profileForm({ profile: view, csrf, next: '/onboarding/skills', submit: 'Save and continue' })}<section class="form-section"><h2>Education (optional)</h2>${editableRecordList(education.map(educationView), (record) => educationForm({ record, csrf, action: `/api/education/${record.id}`, next: '/onboarding/profile', submit: 'Update education' }), csrf, 'education', 'education', '/onboarding/profile')}${educationForm({ csrf, next: '/onboarding/profile', submit: 'Save education' })}</section>${formButton('/api/onboarding', csrf, 'Skip to skills', { className: 'secondary', extra: hidden('step', 'skills') })}`;
  } else if (step === 'skills') {
    content = `<p class="lead">Record skills as declarations with an honest state. Learning and no-evidence are useful signals; they are not failures.</p>${editableRecordList(skills, (record) => skillForm({ record, csrf, action: `/api/skills/${record.id}`, next: '/onboarding/skills', submit: 'Update skill' }), csrf, 'skills', 'skills', '/onboarding/skills')}${skillForm({ csrf, next: '/onboarding/projects', submit: 'Save skill and continue' })}${formButton('/api/onboarding', csrf, 'Skip to projects', { className: 'secondary', extra: hidden('step', 'projects') })}`;
  } else if (step === 'projects') {
    content = `<p class="lead">Projects are where future claims can become traceable. Describe your contribution and outcome without filling in unsupported results.</p>${editableRecordList(projects.map(projectView), (record) => projectForm({ record, csrf, action: `/api/projects/${record.id}`, next: '/onboarding/projects', submit: 'Update project' }), csrf, 'projects', 'projects', '/onboarding/projects')}${projectForm({ csrf, next: '/onboarding/experience', submit: 'Save project and continue' })}${formButton('/api/onboarding', csrf, 'Skip to experience', { className: 'secondary', extra: hidden('step', 'experience') })}`;
  } else if (step === 'experience') {
    content = `<p class="lead">Record real organizations, roles, responsibilities, and references. Career Commander will not infer employment history from technology names.</p>${editableRecordList(experience.map(experienceView), (record) => experienceForm({ record, csrf, action: `/api/experience/${record.id}`, next: '/onboarding/experience', submit: 'Update experience' }), csrf, 'experience', 'experience', '/onboarding/experience')}${experienceForm({ csrf, next: '/onboarding/evidence', submit: 'Save experience and continue' })}${formButton('/api/onboarding', csrf, 'Skip to evidence setup', { className: 'secondary', extra: hidden('step', 'evidence') })}`;
  } else if (step === 'evidence') {
    content = `<p class="lead">Your Evidence Locker will expand in the next phase. For now, this summary shows what Career Commander knows from your explicit skill states.</p>${evidenceSummary(skills)}<div class="boundary-note"><strong>No fit score is calculated here.</strong><span>A score requires an actual opportunity and deterministic requirement matching.</span></div>${formButton('/api/onboarding', csrf, 'Finish onboarding', { extra: hidden('step', 'complete') })}`;
  }
  return layout({
    title: 'Onboarding', principal, csrf,
    body: `<section class="content-card wide-card onboarding-shell"><p class="eyebrow">CAREER COMMANDER SETUP</p><h1>Establish your evidence base.</h1><div class="step-list" aria-label="Onboarding progress">${steps.map((item, index) => `<span class="step ${item === step ? 'current' : index < stepIndex - 1 ? 'done' : ''}">${escapeHtml(item.replace('_', ' '))}</span>`).join('')}</div>${message ? `<p class="message success" role="status">${escapeHtml(message)}</p>` : ''}<div class="onboarding-content"><h2>${escapeHtml(step === 'welcome' ? 'Welcome' : step.replace('_', ' '))}</h2>${content}</div></section>`,
  });
}

function dashboardDataForUser(database, userId) {
  const opportunities = database.listOpportunitiesForUser(userId).map((row) => {
    const opportunity = opportunityView(row);
    const queue = database.opportunityAnalysisSummaryForUser(opportunity.id, userId);
    const roadmap = database.getRoadmapItemsForUser(opportunity.id, userId);
    return { opportunity, queue, roadmap };
  });
  const applications = database.listApplicationsForUser(userId);
  const evidence = database.listEvidenceForUser(userId);
  const discoveryRuns = database.listDiscoveryRunsForUser(userId);
  const roadmap = opportunities.flatMap((entry) => entry.roadmap.map((item) => ({ ...item, opportunity: entry.opportunity })));
  const roadmapCounts = Object.fromEntries(ROADMAP_STATUSES.map((status) => [status, roadmap.filter((item) => item.status === status).length]));
  const attention = [];
  for (const entry of opportunities) {
    if (['FAILED', 'STALE', 'PENDING'].includes(entry.queue.analysisState)) attention.push({ label: `${humanLabel(entry.queue.analysisState)} analysis: ${entry.opportunity.title}`, href: `/opportunities/${encodeURIComponent(entry.opportunity.id)}`, detail: entry.queue.analysisError || 'Review the opportunity analysis state.' });
  }
  for (const application of applications) {
    if (application.status === 'READY_FOR_REVIEW' || application.claimSummary?.unsupported || application.claimSummary?.needsReview) attention.push({ label: `Review application claims`, href: `/applications/${encodeURIComponent(application.id)}`, detail: `${application.claimSummary?.unsupported || 0} unsupported · ${application.claimSummary?.needsReview || 0} needs review` });
  }
  for (const item of roadmap.filter((entry) => entry.status === 'IN_PROGRESS')) attention.push({ label: `Continue roadmap work: ${item.requirementText}`, href: `/opportunities/${encodeURIComponent(item.opportunity.id)}`, detail: `Origin: ${item.opportunity.title}` });
  const profile = database.getProfileForUser(userId);
  if (!profile.onboarding_completed) attention.unshift({ label: `Continue profile setup`, href: '/onboarding', detail: `Next step: ${profile.onboarding_step}` });
  const latestRun = discoveryRuns[0];
  if (latestRun && ['FAILED', 'PARTIAL'].includes(latestRun.status)) attention.push({ label: `${humanLabel(latestRun.status)} discovery run`, href: '/discover', detail: latestRun.errorMessage || 'Review discovery activity.' });
  return { opportunities, applications, evidence, discoveryRuns, roadmap, roadmapCounts, attention: attention.slice(0, 8), profile };
}

function dashboardPage({ principal, csrf, profile, skills, projects = [], evidence = [], dashboard }) {
  const view = profileView(profile);
  const incomplete = !profile.onboarding_completed;
  const data = dashboard || { opportunities: [], applications: [], evidence, roadmap: [], roadmapCounts: {}, attention: [], discoveryRuns: [] };
  const counts = data.roadmapCounts || {};
  const analyzed = data.opportunities.filter((entry) => entry.queue.analysisState === 'READY');
  const recentOpportunities = data.opportunities.slice(0, 5);
  const recentApplications = data.applications.slice(0, 5);
  const recentRuns = data.discoveryRuns.slice(0, 4);
  return layout({
    title: 'Overview', active: 'dashboard', principal, csrf,
    body: `<section class="content-card wide-card"><p class="eyebrow">CAREER COMMANDER · COMMAND CENTER</p><h1>${incomplete ? 'Continue building your evidence base.' : 'Your evidence base is ready to grow. Keep the next career decision visible.'}</h1><p class="lead">${incomplete ? 'Finish the useful parts first. Optional sections can wait until they support a real career decision.' : 'This workspace is a connected view of persisted opportunities, evidence work, and applications. Nothing here runs a provider or invents a readiness score.'}</p>${incomplete ? `<div class="boundary-note"><strong>Next step: ${escapeHtml(profile.onboarding_step)}</strong><span>Progress is saved server-side and can be resumed at any time.</span></div><a class="button" href="/onboarding">Continue onboarding</a>` : evidenceSummary(skills)}<div class="overview-facts"><div><strong>${escapeHtml(view.targetRoles.length ? view.targetRoles.join(', ') : 'No target roles yet')}</strong><span>Career context</span></div><div><strong>${skills.length} skills · ${projects.length} projects</strong><span>Explicit profile records</span></div><div><strong>${data.opportunities.length}</strong><span>Opportunities</span></div><div><strong>${data.evidence.length}</strong><span>Evidence records</span></div></div></section>

      <section class="content-card wide-card" aria-labelledby="attention-title"><div class="section-heading"><div><p class="eyebrow">ATTENTION QUEUE</p><h2 id="attention-title">What needs a decision</h2></div><span class="section-note">Persisted state only</span></div>${data.attention.length ? `<div class="record-list">${data.attention.map((item) => `<article class="opportunity-row"><div><h3><a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a></h3><p>${escapeHtml(item.detail)}</p></div><div><a href="${escapeHtml(item.href)}">Open</a></div></article>`).join('')}</div>` : '<div class="empty-state"><h3>Nothing is waiting for attention.</h3><p>New work will appear here when an analysis, roadmap item, discovery run, or application needs review.</p></div>'}</section>

      <section class="content-card wide-card" aria-labelledby="opportunities-title"><div class="section-heading"><div><p class="eyebrow">OPPORTUNITIES</p><h2 id="opportunities-title">Triage the work</h2></div><a href="/opportunities">View all</a></div>${recentOpportunities.length ? `<div class="record-list">${recentOpportunities.map((entry) => `<article class="opportunity-row"><div><h3><a href="/opportunities/${encodeURIComponent(entry.opportunity.id)}">${escapeHtml(entry.opportunity.title)}</a></h3><p>${escapeHtml(entry.opportunity.company)}${entry.opportunity.location ? ` · ${escapeHtml(entry.opportunity.location)}` : ''}</p></div><div><strong>${escapeHtml(humanLabel(entry.queue.analysisState))}</strong><small>${entry.queue.overallScore == null ? 'Not scored' : `Score ${escapeHtml(String(entry.queue.overallScore))}`} · ${entry.queue.gapCount || 0} gaps</small></div></article>`).join('')}</div>` : '<div class="empty-state"><h3>No opportunities yet.</h3><p>Bring in a job manually or use profile-driven discovery.</p><a class="button" href="/discover">Open discovery</a></div>'}</section>

      <section class="content-card wide-card" aria-labelledby="roadmap-title"><div class="section-heading"><div><p class="eyebrow">ROADMAP</p><h2 id="roadmap-title">Evidence-building work</h2></div><a href="/opportunities">Open reports</a></div>${data.roadmap.length ? `<div class="overview-facts"><div><strong>${counts.PLANNED || 0}</strong><span>Planned</span></div><div><strong>${counts.IN_PROGRESS || 0}</strong><span>In progress</span></div><div><strong>${counts.COMPLETED || 0}</strong><span>Completed</span></div><div><strong>${counts.SKIPPED || 0}</strong><span>Skipped</span></div></div><div class="record-list">${data.roadmap.slice(0, 5).map((item) => `<article class="opportunity-row"><div><h3>${escapeHtml(item.requirementText)}</h3><p>${escapeHtml(item.opportunity.title)}</p></div><div><strong>${escapeHtml(humanLabel(item.status))}</strong><small>${item.evidence?.length || 0} linked evidence item${item.evidence?.length === 1 ? '' : 's'}</small></div></article>`).join('')}</div>` : '<div class="empty-state"><h3>No roadmap work yet.</h3><p>Roadmap items are created from deterministic gaps. A zero-gap opportunity does not need fabricated work.</p></div>'}</section>

      <section class="content-card wide-card" aria-labelledby="applications-title"><div class="section-heading"><div><p class="eyebrow">APPLICATIONS</p><h2 id="applications-title">Human review</h2></div><a href="/applications">View all</a></div>${recentApplications.length ? `<div class="record-list">${recentApplications.map((application) => `<article class="opportunity-row"><div><h3><a href="/applications/${encodeURIComponent(application.id)}">Application draft</a></h3><p>${application.claimSummary?.unsupported || 0} unsupported · ${application.claimSummary?.needsReview || 0} needs review</p></div><div><strong>${escapeHtml(humanLabel(application.status))}</strong><small>Updated ${escapeHtml(application.updatedAt)}</small></div></article>`).join('')}</div>` : '<div class="empty-state"><h3>No application drafts yet.</h3><p>Prepare a draft from an analyzed opportunity when you are ready to review claims.</p></div>'}</section>

      <section class="content-card wide-card" aria-labelledby="activity-title"><div class="section-heading"><div><p class="eyebrow">DISCOVERY ACTIVITY</p><h2 id="activity-title">Source activity</h2></div><a href="/discover">Discover</a></div>${recentRuns.length ? `<div class="record-list">${recentRuns.map((run) => `<article class="opportunity-row"><div><h3>${escapeHtml(humanLabel(run.sourceType))}</h3><p>${escapeHtml(run.startedAt)}</p></div><div><strong>${escapeHtml(run.status)}</strong><small>${run.foundCount} found · ${run.newCount} new · ${run.analyzedCount} analyzed</small></div></article>`).join('')}</div>` : '<div class="empty-state"><h3>No discovery activity yet.</h3><p>Manual intake and provider-backed discovery runs will be recorded here.</p></div>'}</section>

      <section class="content-card wide-card" aria-labelledby="actions-title"><div class="section-heading"><div><p class="eyebrow">QUICK ACTIONS</p><h2 id="actions-title">Choose the next useful action</h2></div></div><div class="actions"><a class="button" href="/discover">Add or discover an opportunity</a><a class="button secondary" href="/evidence/new">Add evidence</a><a class="button secondary" href="/profile">Update profile</a></div></section>`,
  });
}

function discoverPage({ principal, csrf, profile, skills, runs, connections, message = '', error = '' }) {
  const view = profileView(profile);
  const roles = view.targetRoles.length ? view.targetRoles.join(', ') : 'No target roles yet';
  return layout({
    title: 'Discover', active: 'discover', principal, csrf,
    body: `<section class="content-card wide-card"><p class="eyebrow">DISCOVER</p><h1>Find opportunities that fit your context.</h1><p class="lead">Manual intake, profile-driven web search, and mailbox discovery all enter the same opportunity pipeline. External content remains untrusted data.</p>${message ? `<p class="message success" role="status">${escapeHtml(message)}</p>` : ''}${error ? `<p class="message error" role="alert">${escapeHtml(error)}</p>` : ''}<div class="profile-state"><strong>Search context</strong><span>${escapeHtml(roles)}</span><span>${escapeHtml(view.location || 'No location preference')}</span></div><div class="discover-tabs" role="tablist" aria-label="Discovery sources"><a class="discover-tab active" href="#manual">Manual</a><a class="discover-tab" href="#web-search">Web Search</a><a class="discover-tab" href="#email">Email</a></div><section class="discover-section" id="manual"><p class="eyebrow">MANUAL</p><h2>Bring in a job you already have.</h2><p class="section-note">Saving this form creates the opportunity and immediately runs the available analysis pipeline. The opportunity is preserved if a provider stage fails.</p>${opportunityForm({ csrf, action: '/api/discover/manual', next: '/opportunities', submit: 'Analyze opportunity' })}</section><section class="discover-section" id="web-search"><p class="eyebrow">WEB SEARCH</p><h2>Scan using your profile.</h2><p class="section-note">Career Commander will generate targeted queries from your target roles, location, and non-empty-evidence skills. It will not invent live results when OmniRoute is unavailable.</p><form method="post" action="/api/discover/web/scan" class="stack form-section" data-loading-form>${hidden('csrf', csrf)}${hidden('next', '/discover')}<button type="submit">Scan the web</button></form></section><section class="discover-section" id="email"><p class="eyebrow">EMAIL</p><h2>Connect a mailbox adapter.</h2><p class="section-note">An email address alone is not mailbox access. Use a configured Gmail, Outlook, or mock adapter; credentials and provider secrets are never stored here.</p><form method="post" action="/api/discover/email/connect" class="stack form-section">${hidden('csrf', csrf)}${field('Provider', 'provider', connections[0]?.provider || 'MOCK')}<select name="provider"><option value="MOCK">Mock</option><option value="GMAIL">Gmail</option><option value="OUTLOOK">Outlook</option></select>${field('Account label', 'accountLabel', connections[0]?.accountLabel || '', { placeholder: 'Work mailbox' })}<button type="submit">Save mailbox configuration</button></form>${connections.length ? `<p class="connection-state">Configured: ${connections.map((connection) => `<span>${escapeHtml(connection.provider)}${connection.accountLabel ? ` · ${escapeHtml(connection.accountLabel)}` : ''} · ${escapeHtml(connection.status)}</span>`).join('')}</p><form method="post" action="/api/discover/email/scan" class="stack form-section" data-loading-form>${hidden('csrf', csrf)}<button type="submit">Scan email</button></form>` : '<p class="muted">No mailbox connection configured.</p>'}</section><section class="discover-history"><div class="section-heading"><div><p class="eyebrow">RUN HISTORY</p><h2>Discovery runs</h2></div><span class="section-note">Stored from actual runs</span></div>${runs.length ? `<div class="record-list">${runs.map((run) => `<article class="opportunity-row"><div><h3>${escapeHtml(run.sourceType === 'WEB' ? 'Web scan' : run.sourceType === 'EMAIL' ? 'Email scan' : 'Manual intake')}</h3><p>${escapeHtml(run.startedAt)}</p></div><div><strong>${escapeHtml(run.status)}</strong><small>${run.foundCount} found · ${run.newCount} new · ${run.duplicateCount} duplicates · ${run.analyzedCount} analyzed${run.errorMessage ? ` · ${escapeHtml(run.errorMessage)}` : ''}</small></div></article>`).join('')}</div>` : '<p class="empty-state">No discovery runs yet.</p>'}</section></section>`,
  });
}

function applicationsPage({ principal, csrf, applications = [], opportunities = [] }) {
  const opportunityById = new Map(opportunities.map((item) => [item.id, item]));
  return layout({
    title: 'Applications', active: 'applications', principal, csrf,
    body: `<section class="content-card wide-card"><p class="eyebrow">APPLICATIONS</p><h1>Human-reviewed applications.</h1><p class="lead">Drafts remain reviewable records. Claims, supporting evidence, and known gaps stay visible before you decide what to do next. Career Commander never submits an application automatically.</p>${applications.length ? `<div class="record-list">${applications.map((application) => { const opportunity = opportunityById.get(application.opportunityId); return `<article class="opportunity-row"><div><h2><a href="/applications/${encodeURIComponent(application.id)}">${escapeHtml(opportunity?.title || 'Opportunity')}</a></h2><p>${escapeHtml(opportunity?.company || 'Company unavailable')}</p><small>${escapeHtml(application.claimSummary?.unsupported ? `${application.claimSummary.unsupported} unsupported claim${application.claimSummary.unsupported === 1 ? '' : 's'}` : 'Claims checked')} · Updated ${escapeHtml(application.updatedAt)}</small></div><div><span class="status-inline"><span class="status-marker"></span>${escapeHtml(humanLabel(application.status))}</span><small><a href="/applications/${encodeURIComponent(application.id)}">Open review</a></small></div></article>`; }).join('')}</div>` : `<div class="empty-state"><h2>No application drafts yet.</h2><p>Open an analyzed opportunity, review its evidence and claim support, then choose to prepare a draft.</p><a class="button" href="/opportunities">Open opportunities</a></div>`}</section>`,
  });
}

function apiProfile(row) {
  const view = profileView(row);
  return { id: view.id, name: view.name, targetRoles: view.targetRoles, location: view.location, currentStatus: view.current_status, summary: view.summary, onboardingStep: view.onboarding_step, onboardingCompleted: Boolean(view.onboarding_completed), completionState: view.completionState, createdAt: view.created_at, updatedAt: view.updated_at };
}

function apiEducation(row) {
  const view = educationView(row);
  return { id: view.id, institution: view.institution, program: view.program, field: view.field, startDate: view.startDate, endDate: view.endDate, description: view.description, createdAt: view.created_at, updatedAt: view.updated_at };
}

function apiSkill(row) {
  return { id: row.id, name: row.name, status: row.status, supportingReference: row.supporting_reference, description: row.description, createdAt: row.created_at, updatedAt: row.updated_at };
}

function apiProject(row) {
  const view = projectView(row);
  return { id: view.id, name: view.name, description: view.description, technologies: view.technologies, roleContribution: view.roleContribution, timeframeStart: view.timeframeStart, timeframeEnd: view.timeframeEnd, repositoryUrl: view.repositoryUrl, demoUrl: view.demoUrl, outcome: view.outcome, associatedEvidence: view.associatedEvidence, createdAt: view.created_at, updatedAt: view.updated_at };
}

function apiExperience(row) {
  const view = experienceView(row);
  return { id: view.id, organization: view.organization, role: view.role, description: view.description, startDate: view.startDate, endDate: view.endDate, responsibilities: view.responsibilities, technologies: view.technologies, evidenceReference: view.evidenceReference, createdAt: view.created_at, updatedAt: view.updated_at };
}

function apiEvidence(row) {
  const view = evidenceView(row);
  return {
    id: view.id,
    title: view.title,
    description: view.description,
    evidenceType: view.evidenceType,
    status: view.status,
    sourceType: view.sourceType,
    sourceTitle: view.sourceTitle,
    sourceReference: view.sourceReference,
    sourceUrl: view.sourceUrl,
    timeframeStart: view.timeframeStart,
    timeframeEnd: view.timeframeEnd,
    notes: view.notes,
    links: view.links,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

function opportunityView(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    location: row.location,
    rawContent: row.raw_content,
    url: row.job_url,
    canonicalUrl: row.canonical_url,
    sourceType: row.source_type,
    sourceIdentifier: row.source_identifier,
    sourceReference: row.source_reference,
    discoveredAt: row.discovered_at,
    sourceTimestamp: row.source_timestamp,
    lifecycleStatus: row.lifecycle_status,
    normalizedTitle: row.normalized_title,
    normalizedCompany: row.normalized_company,
    contentHash: row.content_hash,
    dedupeKey: row.dedupe_key,
    analysisState: row.analysis_state || 'NOT_STARTED',
    analysisError: row.analysis_error || '',
    analyzedAt: row.analyzed_at || null,
    provenance: row.provenance || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function apiOpportunity(row) {
  const view = opportunityView(row);
  return view ? { ...view } : null;
}

function apiRequirements(row) {
  if (!row) return null;
  return { id: row.id, opportunityId: row.opportunityId, requirementsVersion: row.requirementsVersion, analystVersion: row.analystVersion, provider: row.provider, model: row.model, status: row.status, contentHash: row.contentHash, requirements: row.requirements, errorMessage: row.errorMessage, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

function apiRoadmap(item) {
  return item ? { ...item } : null;
}

function apiApplication(application) {
  return application ? { ...application } : null;
}

function currentApplicationView(application, context) {
  if (!application || !context) return application;
  const freshness = applicationFreshness(application, context);
  if (!freshness.isStale) return application;
  const claims = groundClaims(application.draftText, context);
  return { ...application, stale: true, staleReason: application.staleReason || 'Application source data changed; claims shown are not current for review.', claims, claimSummary: summarizeClaims(claims) };
}

function opportunityForm({ record = {}, csrf, action = '/api/opportunities', next = '/opportunities', submit = 'Save opportunity' }) {
  return `<form method="post" action="${escapeHtml(action)}" class="stack form-section" data-loading-form>
    ${hidden('csrf', csrf)}${next ? hidden('next', next) : ''}
    ${field('Job title', 'title', record.title, { required: true, description: 'The role title used for comparison and deduplication.' })}
    ${field('Company', 'company', record.company, { required: true })}
    ${field('Location', 'location', record.location, { description: 'Optional location or work arrangement.' })}
    ${field('Job URL', 'url', record.url, { type: 'url', description: 'Optional HTTP or HTTPS source link.' })}
    <label>Source <span class="required">Required</span><select name="sourceType" required>${OPPORTUNITY_SOURCES.map((value) => `<option value="${value}"${(record.sourceType || 'MANUAL') === value ? ' selected' : ''}>${escapeHtml(humanLabel(value))}</option>`).join('')}</select></label>
    ${field('Source identifier', 'sourceIdentifier', record.sourceIdentifier, { description: 'Optional identifier from the originating source.' })}
    ${field('Source reference', 'sourceReference', record.sourceReference, { description: 'Optional note about where this opportunity came from.' })}
    ${field('Job description', 'rawContent', record.rawContent, { type: 'textarea', required: true, description: `Preserved as entered. Maximum ${MAX_DESCRIPTION_LENGTH.toLocaleString()} characters.` })}
    <button type="submit">${escapeHtml(submit)}</button>
  </form>`;
}

function requirementListMarkup(title, items) {
  if (!items?.length) return '';
  return `<section class="analysis-subsection"><h3>${escapeHtml(title)}</h3><ul class="analysis-list">${items.map((item) => `<li><strong>${escapeHtml(item.name || item.text)}</strong><span>${escapeHtml(item.text || item.name)}</span></li>`).join('')}</ul></section>`;
}

function jobRequirementsMarkup(requirements) {
  if (!requirements) return '';
  return `<section class="analysis-panel"><div class="section-heading"><div><p class="eyebrow">STRUCTURED ANALYSIS</p><h2>Job requirements</h2></div><span class="status-inline status-verified"><span class="status-marker" aria-hidden="true"></span>Interpretation only</span></div><p class="section-note">This is structured job-posting analysis. It is not a candidate fit decision.</p>${requirementListMarkup('Required skills', requirements.requiredSkills)}${requirementListMarkup('Preferred skills', requirements.preferredSkills)}${requirementListMarkup('Responsibilities', requirements.responsibilities)}${requirementListMarkup('Experience requirements', requirements.experienceRequirements)}${requirementListMarkup('Education requirements', requirements.educationRequirements)}${requirementListMarkup('Location requirements', requirements.locationRequirements)}${requirementListMarkup('Other constraints', requirements.otherConstraints)}</section>`;
}

function matchResultsMarkup(run) {
  if (!run) return '';
  return `<section class="analysis-panel"><div class="section-heading"><div><p class="eyebrow">DETERMINISTIC MATCH</p><h2>Evidence match</h2></div><span class="section-note">Rules version ${escapeHtml(run.matcherVersion)}</span></div><div class="table-wrap"><table><thead><tr><th>Requirement</th><th>Type</th><th>Result</th><th>Evidence</th><th>Reason</th></tr></thead><tbody>${run.results.map((result) => `<tr><th scope="row">${escapeHtml(result.requirementText)}</th><td>${escapeHtml(`${humanLabel(result.priority)} ${humanLabel(result.requirementType)}`)}</td><td><span class="status-inline status-${result.matchState.toLowerCase()}"><span class="status-marker" aria-hidden="true"></span>${escapeHtml(result.matchState)}</span></td><td>${result.evidence.length ? result.evidence.map((item) => escapeHtml(`${item.title} (${item.status})`)).join('<br>') : '<span class="muted">None</span>'}</td><td>${escapeHtml(result.reason)}</td></tr>`).join('')}</tbody></table></div></section>`;
}

function scoreMarkup(score) {
  if (!score) return '';
  return `<section class="analysis-panel"><div class="section-heading"><div><p class="eyebrow">FIT SCORE</p><h2>${escapeHtml(String(score.overallScore))} / 100</h2></div><span class="section-note">Formula ${escapeHtml(score.formulaVersion)}</span></div><p class="section-note">${escapeHtml(score.formula)}</p><div class="score-breakdown"><div><strong>${escapeHtml(String(score.requiredScore ?? 'Not applicable'))}${score.requiredScore === null ? '' : '%'}</strong><span>Required</span><small>${score.requiredMatches} matched, ${score.requiredPartials} partial, ${score.requiredMissing} missing</small></div><div><strong>${escapeHtml(String(score.preferredScore ?? 'Not applicable'))}${score.preferredScore === null ? '' : '%'}</strong><span>Preferred</span><small>${score.preferredMatches} matched, ${score.preferredPartials} partial, ${score.preferredMissing} missing</small></div></div></section>`;
}

function gapsMarkup(gaps, roadmap = []) {
  if (!gaps?.length) return gaps ? '<section class="analysis-panel confirmation-state"><strong>No gaps from the current match results.</strong><span>Every scored requirement is currently a MATCH.</span></section>' : '';
  const roadmapByRequirement = new Map((roadmap.length ? roadmap : (gaps.roadmap || [])).map((item) => [item.requirementId, item]));
  return `<section class="analysis-panel"><div class="section-heading"><div><p class="eyebrow">GAP ANALYSIS</p><h2>Gaps</h2></div><span class="section-note">Evidence-grounded</span></div><div class="gap-list">${gaps.map((gap) => { const roadmapItem = roadmapByRequirement.get(gap.requirementId); return `<details class="gap-item"><summary><span>${escapeHtml(humanLabel(gap.priority))} gap</span><strong>${escapeHtml(gap.requirementText)}</strong><em>${escapeHtml(gap.gapState)}</em></summary><div><p><strong>Current evidence:</strong> ${gap.currentEvidence.length ? gap.currentEvidence.map((item) => escapeHtml(item.title)).join(', ') : 'None stored.'}</p><p>${escapeHtml(gap.missingCapability)}</p><p>${escapeHtml(gap.explanation)}</p><p class="muted"><strong>Possible next action:</strong> ${escapeHtml(gap.nextAction)}</p>${roadmapItem ? `<p class="evidence-provenance"><strong>Roadmap:</strong> ${escapeHtml(roadmapItem.task)} · ${escapeHtml(humanLabel(roadmapItem.status))}</p>` : '<p class="muted">No roadmap item has been generated for this gap yet.</p>'}</div></details>`; }).join('')}</div></section>`;
}

function roadmapMarkup({ opportunityId, roadmap = [], evidence = [], csrf, freshness }) {
  if (freshness?.isStale || roadmap?.stale) return '<section class="analysis-panel report-panel"><div class="section-heading"><div><p class="eyebrow">EVIDENCE ROADMAP</p><h2>Refresh required</h2></div></div><p class="muted">Roadmap work is hidden until the underlying requirements, evidence match, score, and gaps are current.</p></section>';
  const counts = Object.fromEntries(ROADMAP_STATUSES.map((status) => [status, roadmap.filter((item) => item.status === status).length]));
  return `<section class="analysis-panel report-panel"><div class="section-heading"><div><p class="eyebrow">EVIDENCE ROADMAP</p><h2>Turn gaps into proof</h2></div><div class="actions"><span class="section-note">${roadmap.length ? `${counts.PLANNED || 0} planned · ${counts.IN_PROGRESS || 0} in progress · ${counts.COMPLETED || 0} completed · ${counts.SKIPPED || 0} skipped` : 'Derived from persisted gaps'}</span><form method="post" action="/api/opportunities/${encodeURIComponent(opportunityId)}/roadmap/generate" class="inline-form" data-loading-form>${hidden('csrf', csrf)}${hidden('next', `/opportunities/${encodeURIComponent(opportunityId)}`)}<button type="submit">Generate / regenerate roadmap</button></form></div></div>${roadmap.length ? `<div class="gap-list">${roadmap.map((item) => `<article class="gap-item"><div class="gap-item-heading"><span>${escapeHtml(item.priority)} gap</span><strong>${escapeHtml(item.requirementText)}</strong><em>${escapeHtml(item.gapState)}</em></div><p><strong>Suggested work:</strong> ${escapeHtml(item.task)}</p><p class="muted"><strong>Expected evidence:</strong> ${escapeHtml(item.potentialEvidence)}</p><p class="muted"><strong>Created:</strong> ${escapeHtml(item.createdAt)} · <strong>Updated:</strong> ${escapeHtml(item.updatedAt || item.createdAt)}</p><form method="post" action="/api/roadmap-items/${encodeURIComponent(item.id)}/status" class="inline-form" data-loading-form>${hidden('csrf', csrf)}${hidden('next', `/opportunities/${encodeURIComponent(opportunityId)}`)}<label>Status <select name="status">${ROADMAP_STATUSES.map((status) => `<option value="${status}"${item.status === status ? ' selected' : ''}>${escapeHtml(humanLabel(status))}</option>`).join('')}</select></label><button type="submit">Save status</button></form>${item.evidence?.length ? `<p class="evidence-provenance"><strong>Linked evidence:</strong> ${item.evidence.map((entry) => `<span><a href="/evidence/${encodeURIComponent(entry.id)}">${escapeHtml(entry.title)}</a> · ${escapeHtml(entry.status)}</span>`).join(', ')}</p>${item.evidence.map((entry) => `<form method="post" action="/api/roadmap-items/${encodeURIComponent(item.id)}/evidence/${encodeURIComponent(entry.id)}/unlink" class="inline-form" data-loading-form>${hidden('csrf', csrf)}${hidden('next', `/opportunities/${encodeURIComponent(opportunityId)}`)}<button class="secondary" type="submit">Unlink ${escapeHtml(entry.title)}</button></form>`).join('')}` : '<p class="muted">No evidence linked yet.</p>'}${evidence.length ? `<form method="post" action="/api/roadmap-items/${encodeURIComponent(item.id)}/evidence" class="inline-form" data-loading-form>${hidden('csrf', csrf)}${hidden('next', `/opportunities/${encodeURIComponent(opportunityId)}`)}<label>Link evidence <select name="evidenceId" required><option value="">Choose an Evidence Locker item</option>${evidence.map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.title)}</option>`).join('')}</select></label><button type="submit">Link evidence</button></form>` : '<p class="muted">Add an Evidence Locker item before linking proof.</p>'}<p class="form-link"><a href="/evidence/new">Create an evidence artifact</a> in Evidence Locker, then link it here.</p></article>`).join('')}</div>` : '<div class="confirmation-state"><strong>No identified gaps.</strong><span>No roadmap work was fabricated because the deterministic gap set is empty.</span></div>'}</section>`;
}

function opportunityReportMarkup({ report, companySignals, relevance, roadmap, application, csrf, opportunityId, freshness }) {
  if (!report) return '<section class="analysis-panel"><h2>Opportunity report</h2><p class="muted">The consolidated report will appear after the deterministic pipeline completes.</p></section>';
  const freshnessState = freshness || report.freshness;
  if (freshnessState?.isStale) return `<section class="analysis-panel report-panel" role="status"><div class="section-heading"><div><p class="eyebrow">OPPORTUNITY REPORT</p><h2>Analysis needs refresh</h2></div><span class="status-inline status-partial"><span class="status-marker" aria-hidden="true"></span>STALE</span></div><p>The saved report is not presented as current because one or more source records changed.</p><p class="muted"><strong>Reason:</strong> ${freshnessState.reasons.map((reason) => escapeHtml(humanLabel(reason))).join(', ')}</p>${freshnessState.lastAnalyzedAt ? `<p class="muted">Last analyzed: ${escapeHtml(freshnessState.lastAnalyzedAt)}</p>` : ''}</section>`;
  const data = report.report || report;
  const signals = companySignals || data.companySignals;
  const projects = relevance?.projects || data.relevantProjects || [];
  const work = roadmap || data.suggestedEvidenceWork || [];
  if (data.synthesizedSummary || data.opportunity?.analyzedAt) data.overallAssessment = `${data.synthesizedSummary || ''} ${data.opportunity?.analyzedAt ? `Last analyzed: ${data.opportunity.analyzedAt}.` : ''} ${data.overallAssessment || ''}`.trim();
  return `<section class="analysis-panel report-panel"><div class="section-heading"><div><p class="eyebrow">OPPORTUNITY REPORT</p><h2>One reviewable picture</h2></div><span class="section-note">${escapeHtml(report.status || 'READY')}</span></div><section class="report-section"><h3>Company signals</h3><p class="section-note">OBSERVED describes source content; INFERRED is an interpretation, not a confirmed company fact.</p>${signals?.signals?.length ? `<div class="signal-list">${signals.signals.map((signal) => `<div><strong>${escapeHtml(signal.certainty || 'OBSERVED')}</strong><span>${escapeHtml(signal.label || '')}</span><p>${escapeHtml(signal.value || '')}</p><small>${escapeHtml(signal.source || '')}</small></div>`).join('')}</div>` : `<p class="muted">${escapeHtml(signals?.errorMessage || 'No company signals are available.')}</p>`}</section><section class="report-section"><h3>Relevant candidate projects</h3>${projects.length ? `<div class="record-list">${projects.map((project) => `<article class="opportunity-row"><div><strong>${escapeHtml(project.project || project.name || '')}</strong><p>${escapeHtml((project.relevantTechnologies || []).join(', '))}</p></div><div><small>${escapeHtml(project.whyRelevant || 'Relevance grounded in profile project data.')}</small></div></article>`).join('')}</div>` : '<p class="muted">No candidate project relevance was established from the current profile data.</p>'}</section><section class="report-section"><h3>Overall assessment</h3><p>${escapeHtml(data.overallAssessment || 'No assessment is available.')}</p></section>${application ? `<section class="report-section"><h3>Application</h3><p>${escapeHtml(humanLabel(application.status))} · ${application.claimSummary?.unsupported || 0} unsupported · ${application.claimSummary?.needsReview || 0} needing review</p><a class="button" href="/applications/${encodeURIComponent(application.id)}">Open application review</a></section>` : `<section class="report-section"><h3>Application</h3><p>Prepare a draft from the existing profile, evidence, requirements, matches, score, and gaps.</p><form method="post" action="/api/opportunities/${encodeURIComponent(opportunityId)}/application" data-loading-form>${hidden('csrf', csrf)}${hidden('next', `/opportunities/${encodeURIComponent(opportunityId)}`)}<button type="submit">Prepare application draft</button></form></section>`}</section>`;
}

function opportunityListPage({ principal, csrf, opportunities, message = '' }) {
  return layout({
    title: 'Opportunities', active: 'opportunities', principal, csrf,
    body: `<section class="content-card wide-card"><div class="page-heading"><div><p class="eyebrow">OPPORTUNITIES</p><h1>Jobs worth examining.</h1><p class="lead">Bring in a job manually and preserve the source before any later analysis begins.</p></div><a class="button" href="/opportunities/new">Add opportunity</a></div>${message ? `<p class="message success" role="status">${escapeHtml(message)}</p>` : ''}${opportunities.length ? `<div class="record-list opportunity-list">${opportunities.map((item) => `<article class="opportunity-row"><div><h2><a href="/opportunities/${encodeURIComponent(item.id)}">${escapeHtml(item.title)}</a></h2><p>${escapeHtml(item.company)}${item.location ? ` · ${escapeHtml(item.location)}` : ''}</p></div><div><span class="status-inline"><span class="status-marker" aria-hidden="true"></span>${escapeHtml(humanLabel(item.lifecycleStatus))}</span><small>${escapeHtml(humanLabel(item.sourceType))} · ${escapeHtml(item.updatedAt)}</small></div></article>`).join('')}</div>` : `<div class="empty-state"><h2>No opportunities yet.</h2><p>Add a job description manually. Internet and email intake are reserved for later phases.</p><a class="button" href="/opportunities/new">Add opportunity</a></div>`}</section>`,
  });
}

function opportunityDetailPage({ principal, csrf, opportunity, requirements, matchRun, score, gapRun, gaps, message = '', error = '' }) {
  const hasRequirements = Boolean(requirements);
  const hasMatch = Boolean(matchRun);
  return layout({
    title: opportunity.title, active: 'opportunities', principal, csrf,
    body: `<section class="content-card wide-card"><p class="eyebrow">OPPORTUNITY</p><div class="page-heading"><div><h1>${escapeHtml(opportunity.title)}</h1><p class="lead">${escapeHtml(opportunity.company)}${opportunity.location ? ` · ${escapeHtml(opportunity.location)}` : ''}</p></div><a href="/opportunities">Back to opportunities</a></div>${message ? `<p class="message success" role="status">${escapeHtml(message)}</p>` : ''}${error ? `<p class="message error" role="alert">${escapeHtml(error)}</p>` : ''}<div class="profile-state"><strong>${escapeHtml(humanLabel(opportunity.lifecycleStatus))}</strong><span>Source: ${escapeHtml(humanLabel(opportunity.sourceType))}</span><span>Updated: ${escapeHtml(opportunity.updatedAt)}</span></div><section class="detail-section"><h2>Source content</h2>${opportunity.url ? `<p><a href="${escapeHtml(opportunity.url)}" target="_blank" rel="noopener noreferrer">Open source URL</a></p>` : ''}<pre class="raw-content">${escapeHtml(opportunity.rawContent)}</pre></section><section class="detail-section"><h2>Provenance</h2><div class="relationship-list">${opportunity.provenance.map((item) => `<span class="relationship-chip">${escapeHtml(humanLabel(item.sourceType))}${item.sourceReference ? `: ${escapeHtml(item.sourceReference)}` : ''} · ${escapeHtml(item.discoveredAt)}</span>`).join('')}</div></section><details class="form-section"><summary>Edit opportunity</summary>${opportunityForm({ record: opportunity, csrf, action: `/api/opportunities/${encodeURIComponent(opportunity.id)}`, next: `/opportunities/${encodeURIComponent(opportunity.id)}`, submit: 'Update opportunity' })}</details>${formButton(`/api/opportunities/${encodeURIComponent(opportunity.id)}/delete`, csrf, 'Delete opportunity', { className: 'danger-button', extra: hidden('next', '/opportunities') })}<section class="detail-section analysis-controls"><h2>Analysis pipeline</h2><p class="section-note">Each stage consumes the previous structured output. No score or gap is shown before its required upstream stage exists.</p><div class="actions">${!hasRequirements ? `<form method="post" action="/api/opportunities/${encodeURIComponent(opportunity.id)}/analyze" data-loading-form>${hidden('csrf', csrf)}${hidden('next', `/opportunities/${encodeURIComponent(opportunity.id)}`)}<button type="submit">Analyze requirements</button></form>` : `<span class="confirmation-state">Requirements analyzed</span>`}${hasRequirements && !hasMatch ? `<form method="post" action="/api/opportunities/${encodeURIComponent(opportunity.id)}/match" data-loading-form>${hidden('csrf', csrf)}${hidden('next', `/opportunities/${encodeURIComponent(opportunity.id)}`)}<button type="submit">Match evidence</button></form>` : ''}${hasMatch && !score ? `<form method="post" action="/api/opportunities/${encodeURIComponent(opportunity.id)}/score" data-loading-form>${hidden('csrf', csrf)}${hidden('next', `/opportunities/${encodeURIComponent(opportunity.id)}`)}<button type="submit">Calculate score</button></form>` : ''}${hasMatch && score && !gapRun ? `<form method="post" action="/api/opportunities/${encodeURIComponent(opportunity.id)}/gaps" data-loading-form>${hidden('csrf', csrf)}${hidden('next', `/opportunities/${encodeURIComponent(opportunity.id)}`)}<button type="submit">Analyze gaps</button></form>` : ''}</div></section>${jobRequirementsMarkup(requirements?.requirements)}${matchResultsMarkup(matchRun)}${scoreMarkup(score)}${gapsMarkup(gapRun ? gaps : null)}</section>`,
  });
}

function opportunityQueuePage({ principal, csrf, opportunities, message = '' }) {
  return layout({
    title: 'Opportunities', active: 'opportunities', principal, csrf,
    body: `<section class="content-card wide-card"><div class="page-heading"><div><p class="eyebrow">OPPORTUNITIES</p><h1>Your working queue.</h1><p class="lead">Manual, web, and email opportunities converge here with their source, score, analysis state, and current gaps.</p></div><a class="button" href="/discover#manual">Analyze an opportunity</a></div>${message ? `<p class="message success" role="status">${escapeHtml(message)}</p>` : ''}${opportunities.length ? `<div class="record-list opportunity-list">${opportunities.map((item) => { const queue = item.queue || {}; return `<article class="opportunity-row"><div><h2><a href="/opportunities/${encodeURIComponent(item.id)}">${escapeHtml(item.title)}</a></h2><p>${escapeHtml(item.company)}${item.location ? ` · ${escapeHtml(item.location)}` : ''}</p><small>${escapeHtml(humanLabel(item.sourceType))} · ${escapeHtml(item.updatedAt)}</small></div><div><strong>${queue.overallScore === null || queue.overallScore === undefined ? 'Not scored' : `${queue.overallScore} / 100`}</strong><span class="status-inline"><span class="status-marker" aria-hidden="true"></span>${escapeHtml(queue.analysisState || item.analysisState)}</span><small>${queue.requiredGapCount || 0} required gap${queue.requiredGapCount === 1 ? '' : 's'} · <a href="/opportunities/${encodeURIComponent(item.id)}">Open report</a></small></div></article>`; }).join('')}</div>` : `<div class="empty-state"><h2>No opportunities yet.</h2><p>Start from Discover. Nothing appears here until a real opportunity is added or discovered.</p><a class="button" href="/discover">Open Discover</a></div>`}</section>`,
  });
}

function applicationPage({ principal, csrf, application, opportunity, message = '', error = '' }) {
  const claims = application.claims || [];
  return layout({
    title: 'Application review', active: 'applications', principal, csrf,
    body: `<section class="content-card wide-card"><p class="eyebrow">APPLICATION REVIEW</p><div class="page-heading"><div><h1>${escapeHtml(opportunity.title)}</h1><p class="lead">${escapeHtml(opportunity.company)} · ${escapeHtml(humanLabel(application.status))}</p></div><a href="/opportunities/${encodeURIComponent(opportunity.id)}">Back to opportunity report</a></div>${message ? `<p class="message success" role="status">${escapeHtml(message)}</p>` : ''}${error ? `<p class="message error" role="alert">${escapeHtml(error)}</p>` : ''}<div class="boundary-note"><strong>Human review remains required.</strong><span>This draft has not been submitted and no submission action exists in Career Commander.</span></div><section class="detail-section"><h2>Draft</h2><form method="post" action="/api/applications/${encodeURIComponent(application.id)}" class="stack form-section" data-loading-form>${hidden('csrf', csrf)}${hidden('next', `/applications/${encodeURIComponent(application.id)}`)}${field('Application draft', 'draftText', application.draftText, { type: 'textarea', required: true, description: 'Edit freely. Saving re-checks every sentence against the available profile and evidence.' })}<button type="submit">Save draft and check claims</button></form></section><section class="detail-section"><div class="section-heading"><div><h2>Claim grounding</h2><p class="section-note">These verdicts are review signals, not automatic approval.</p></div><span class="section-note">${escapeHtml(String(application.claimSummary?.supported || 0))} supported · ${escapeHtml(String(application.claimSummary?.unsupported || 0))} unsupported · ${escapeHtml(String(application.claimSummary?.needsReview || 0))} needs review</span></div>${claims.length ? `<div class="claim-list">${claims.map((claim) => `<article class="claim-case"><p>${escapeHtml(claim.claimText)}</p><strong class="claim-verdict ${claim.verdict.toLowerCase()}">${escapeHtml(claim.verdict)}</strong><small>${escapeHtml(claim.reason)}</small>${claim.evidence?.length ? `<div class="relationship-list">${claim.evidence.map((entry) => `<a class="relationship-chip" href="/evidence/${encodeURIComponent(entry.id)}">${escapeHtml(entry.title)} · ${escapeHtml(entry.status)}</a>`).join('')}</div>` : '<p class="muted">No linked evidence.</p>'}</article>`).join('')}</div>` : '<p class="muted">No claims were extracted yet.</p>'}</section><section class="detail-section"><h2>Review state</h2><p class="section-note">Marking this record ready does not submit it. It only records that you have reviewed the draft and its claim support.</p><form method="post" action="/api/applications/${encodeURIComponent(application.id)}/review" class="inline-form" data-loading-form>${hidden('csrf', csrf)}${hidden('next', `/applications/${encodeURIComponent(application.id)}`)}${field('Review note', 'reviewNote', application.reviewNote, { placeholder: 'Optional note for your future self' })}<button type="submit">Mark ready for human review</button></form></section></section>`,
  });
}

function opportunityReportPage({ principal, csrf, opportunity, requirements, matchRun, score, gapRun, gaps, report, companySignals, relevance, roadmap, evidence = [], application, freshness, message = '', error = '' }) {
  const hasRequirements = Boolean(requirements);
  return layout({
    title: opportunity.title, active: 'opportunities', principal, csrf,
    body: `<section class="content-card wide-card"><p class="eyebrow">OPPORTUNITY REPORT</p><div class="page-heading"><div><h1>${escapeHtml(opportunity.title)}</h1><p class="lead">${escapeHtml(opportunity.company)}${opportunity.location ? ` · ${escapeHtml(opportunity.location)}` : ''}</p></div><a href="/opportunities">Back to opportunities</a></div>${message ? `<p class="message success" role="status">${escapeHtml(message)}</p>` : ''}${error ? `<p class="message error" role="alert">${escapeHtml(error)}</p>` : ''}<div class="profile-state"><strong>${escapeHtml(humanLabel(opportunity.analysisState))}</strong><span>Source: ${escapeHtml(humanLabel(opportunity.sourceType))}</span><span>Discovered: ${escapeHtml(opportunity.discoveredAt)}</span></div><section class="detail-section"><h2>Opportunity</h2><dl class="detail-grid"><div><dt>Role</dt><dd>${escapeHtml(opportunity.title)}</dd></div><div><dt>Company</dt><dd>${escapeHtml(opportunity.company)}</dd></div><div><dt>Location</dt><dd>${escapeHtml(opportunity.location || 'Not supplied')}</dd></div><div><dt>Source</dt><dd>${escapeHtml(humanLabel(opportunity.sourceType))}</dd></div></dl>${opportunity.url ? `<p><a href="${escapeHtml(opportunity.url)}" target="_blank" rel="noopener noreferrer">Open source URL</a></p>` : ''}</section><section class="detail-section"><h2>Original source</h2><pre class="raw-content">${escapeHtml(opportunity.rawContent)}</pre></section><section class="detail-section"><h2>Provenance</h2><div class="relationship-list">${opportunity.provenance.map((item) => `<span class="relationship-chip">${escapeHtml(humanLabel(item.sourceType))}${item.sourceReference ? `: ${escapeHtml(item.sourceReference)}` : ''} · ${escapeHtml(item.discoveredAt)}</span>`).join('')}</div></section>${opportunity.analysisError ? `<div class="message error" role="alert">${escapeHtml(opportunity.analysisError)} Retry after checking the provider.</div>` : ''}<section class="detail-section analysis-controls"><h2>Analysis pipeline</h2><p class="section-note">The report is assembled from structured analysis and deterministic results. No score or gap claim is shown before its upstream stage exists.</p><div class="actions">${!hasRequirements || opportunity.analysisState.startsWith('FAILED') ? `<form method="post" action="/api/opportunities/${encodeURIComponent(opportunity.id)}/analyze" data-loading-form>${hidden('csrf', csrf)}${hidden('next', `/opportunities/${encodeURIComponent(opportunity.id)}`)}<button type="submit">Retry analysis</button></form>` : '<span class="confirmation-state">Automatic analysis complete</span>'}</div></section>${jobRequirementsMarkup(requirements?.requirements)}${matchResultsMarkup(matchRun)}${scoreMarkup(score)}${gapsMarkup(gapRun ? gaps : null)}${opportunityReportMarkup({ report, companySignals, relevance, roadmap, application, csrf, opportunityId: opportunity.id })}${roadmapMarkup({ opportunityId: opportunity.id, roadmap, evidence, csrf })}<details class="form-section"><summary>Edit opportunity</summary>${opportunityForm({ record: opportunity, csrf, action: `/api/opportunities/${encodeURIComponent(opportunity.id)}`, next: `/opportunities/${encodeURIComponent(opportunity.id)}`, submit: 'Update opportunity' })}</details>${formButton(`/api/opportunities/${encodeURIComponent(opportunity.id)}/delete`, csrf, 'Delete opportunity', { className: 'danger-button', extra: hidden('next', '/opportunities') })}</section>`,
  });
}

function evidenceLinkKey(link) {
  return `${link.entityType}:${link.entityId}`;
}

function evidenceLinkChanges(before = [], after = []) {
  const oldLinks = new Map(before.map((link) => [evidenceLinkKey(link), link]));
  const newLinks = new Map(after.map((link) => [evidenceLinkKey(link), link]));
  return {
    linked: [...newLinks.values()].filter((link) => !oldLinks.has(evidenceLinkKey(link))),
    unlinked: [...oldLinks.values()].filter((link) => !newLinks.has(evidenceLinkKey(link))),
  };
}

function evidenceView(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    evidenceType: row.evidence_type,
    status: row.status_context,
    sourceType: row.source_type,
    sourceTitle: row.source_title || '',
    sourceReference: row.source_reference,
    sourceUrl: row.source_url || '',
    timeframeStart: row.timeframe_start || '',
    timeframeEnd: row.timeframe_end || '',
    notes: row.notes || '',
    links: row.links || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function humanLabel(value) {
  return String(value || '').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function linkSelections(links = []) {
  return Object.fromEntries(LINK_TYPES.map((type) => [type, new Set(links.filter((link) => link.entityType === type).map((link) => link.entityId))]));
}

function evidenceOptions({ skills = [], projects = [], experience = [], education = [] } = {}) {
  return {
    skill: skills.map((item) => ({ id: item.id, label: item.name })),
    project: projects.map((item) => ({ id: item.id, label: item.name })),
    experience: experience.map((item) => ({ id: item.id, label: `${item.organization} / ${item.role}` })),
    education: education.map((item) => ({ id: item.id, label: `${item.institution} / ${item.program}` })),
  };
}

function selectedEvidenceLinks(row) {
  return linkSelections(row.links || []);
}

function relationCheckboxes(type, label, options, selected) {
  const items = options[type] || [];
  return `<fieldset class="relationship-group"><legend>${escapeHtml(label)}</legend>${items.length
    ? items.map((item) => `<label class="checkbox-label"><input type="checkbox" name="${type}Ids[]" value="${escapeHtml(item.id)}"${selected[type].has(item.id) ? ' checked' : ''}><span>${escapeHtml(item.label)}</span></label>`).join('')
    : '<p class="muted">No records available yet.</p>'}</fieldset>`;
}

function evidenceForm({ record = {}, csrf, options, action = '/api/evidence', next = '/evidence', submit = 'Save evidence' }) {
  const selected = selectedEvidenceLinks(record);
  return `<form method="post" action="${escapeHtml(action)}" class="stack form-section" data-loading-form>
    ${hidden('csrf', csrf)}${next ? hidden('next', next) : ''}
    ${field('Title', 'title', record.title, { required: true, description: 'A concise name for the source-backed item.' })}
    ${field('Description', 'description', record.description, { type: 'textarea', required: true, description: 'What does this support? This is user-provided evidence, not independent verification.' })}
    <label>Evidence type <span class="required">Required</span><select name="evidenceType" required>${EVIDENCE_TYPES.map((value) => `<option value="${value}"${record.evidenceType === value ? ' selected' : ''}>${escapeHtml(humanLabel(value))}</option>`).join('')}</select></label>
    <label>Capability context <span class="required">Required</span><select name="status" required>${EVIDENCE_STATUSES.map((value) => `<option value="${value}"${(record.status || 'NO_EVIDENCE') === value ? ' selected' : ''}>${escapeHtml(humanLabel(value))}</option>`).join('')}</select><small>This describes the candidate context. It does not mean Career Commander independently verified the source.</small></label>
    <label>Source type <span class="required">Required</span><select name="sourceType" required>${SOURCE_TYPES.map((value) => `<option value="${value}"${(record.sourceType || 'USER_PROVIDED_REFERENCE') === value ? ' selected' : ''}>${escapeHtml(humanLabel(value))}</option>`).join('')}</select></label>
    ${field('Source title', 'sourceTitle', record.sourceTitle, { description: 'Optional title supplied by you.' })}
    ${field('Source or reference', 'sourceReference', record.sourceReference, { required: true, description: 'Describe where this came from, such as a repository, work artifact, or certificate.' })}
    ${field('Source URL', 'sourceUrl', record.sourceUrl, { type: 'url', description: 'Optional HTTP or HTTPS reference supplied by you.' })}
    <div class="two-column">${field('From', 'timeframeStart', record.timeframeStart, { type: 'date' })}${field('To', 'timeframeEnd', record.timeframeEnd, { type: 'date' })}</div>
    ${field('Notes', 'notes', record.notes, { type: 'textarea', description: 'Optional context for later review.' })}
    <fieldset class="relationship-fieldset"><legend>Associate explicitly <span class="optional">Optional</span></legend><p class="section-note">Choose the profile records this evidence supports. Relationships are never inferred from keywords.</p>${relationCheckboxes('skill', 'Skills', options, selected)}${relationCheckboxes('project', 'Projects', options, selected)}${relationCheckboxes('experience', 'Experience', options, selected)}${relationCheckboxes('education', 'Education', options, selected)}</fieldset>
    <button type="submit">${escapeHtml(submit)}</button>
  </form>`;
}

function evidenceRecordWithLabels(record, options) {
  const view = evidenceView(record);
  return {
    ...view,
    related: (record.links || []).map((link) => ({ ...link, label: (options[link.entityType] || []).find((item) => item.id === link.entityId)?.label || 'Record no longer available' })),
  };
}

function evidenceLinksText(record) {
  if (!record.related.length) return '<span class="muted">No profile records linked.</span>';
  return record.related.map((link) => `<span class="relationship-chip">${escapeHtml(humanLabel(link.entityType))}: ${escapeHtml(link.label)}</span>`).join('');
}

function evidenceLockerPage({ principal, csrf, records, options, filters, message = '' }) {
  const query = filters.query || '';
  const selectedStatus = filters.status || '';
  const selectedType = filters.evidenceType || '';
  return layout({
    title: 'Evidence Locker', active: 'evidence', principal, csrf,
    body: `<section class="content-card wide-card">
      <p class="eyebrow">EVIDENCE LOCKER</p><div class="page-heading"><div><h1>Your source-backed record.</h1><p class="lead">Keep concrete evidence separate from profile declarations so later analysis can inspect what each claim points to.</p></div><a class="button" href="/evidence/new">Add evidence</a></div>
      ${message ? `<p class="message ${message === 'Saved.' || message === 'Evidence deleted.' ? 'success' : 'error'}" role="status">${escapeHtml(message)}</p>` : ''}
      <form method="get" action="/evidence" class="evidence-toolbar" data-loading-form>
        ${field('Search evidence', 'q', query, { placeholder: 'Search title, description, source or notes' })}
        <label>Status <span class="optional">Optional</span><select name="status"><option value="">All statuses</option>${EVIDENCE_STATUSES.map((value) => `<option value="${value}"${selectedStatus === value ? ' selected' : ''}>${escapeHtml(humanLabel(value))}</option>`).join('')}</select></label>
        <label>Type <span class="optional">Optional</span><select name="type"><option value="">All types</option>${EVIDENCE_TYPES.map((value) => `<option value="${value}"${selectedType === value ? ' selected' : ''}>${escapeHtml(humanLabel(value))}</option>`).join('')}</select></label>
        ${['skill', 'project', 'experience', 'education'].map((type) => `<label>${escapeHtml(humanLabel(type))} <span class="optional">Optional</span><select name="${type}Id"><option value="">All ${escapeHtml(humanLabel(type))}</option>${(options[type] || []).map((item) => `<option value="${escapeHtml(item.id)}"${filters[`${type}Id`] === item.id ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}</select></label>`).join('')}
        <div class="actions"><button type="submit">Filter</button><a class="button secondary" href="/evidence">Clear</a></div>
      </form>
      ${records.length ? `<div class="evidence-list" aria-label="Evidence records">${records.map((record) => `<article class="evidence-entry"><div class="evidence-entry-header"><div><h2><a href="/evidence/${encodeURIComponent(record.id)}">${escapeHtml(record.title)}</a></h2><p class="evidence-meta"><span class="status-inline status-${record.status.toLowerCase()}"><span class="status-marker" aria-hidden="true"></span>${escapeHtml(humanLabel(record.status))}</span><span>${escapeHtml(humanLabel(record.evidenceType))}</span></p></div><a href="/evidence/${encodeURIComponent(record.id)}">View evidence</a></div><p>${escapeHtml(record.description)}</p><p class="evidence-provenance"><strong>${escapeHtml(humanLabel(record.sourceType))}</strong><span>${escapeHtml(record.sourceTitle || record.sourceReference)}</span></p><div class="relationship-list">${evidenceLinksText(record)}</div></article>`).join('')}</div>` : `<div class="empty-state"><h2>No evidence yet.</h2><p>Add projects, work examples, repositories or other supporting material that Career Commander can use later.</p><a class="button" href="/evidence/new">Add evidence</a></div>`}
    </section>`,
  });
}

function evidenceDetailPage({ principal, csrf, record, options, message = '' }) {
  return layout({
    title: record.title, active: 'evidence', principal, csrf,
    body: `<section class="content-card wide-card"><p class="eyebrow">EVIDENCE DETAIL</p><div class="page-heading"><div><h1>${escapeHtml(record.title)}</h1><p class="evidence-meta"><span class="status-inline status-${record.status.toLowerCase()}"><span class="status-marker" aria-hidden="true"></span>Capability context: ${escapeHtml(humanLabel(record.status))}</span><span>${escapeHtml(humanLabel(record.evidenceType))}</span></p></div><a href="/evidence">Back to Evidence Locker</a></div>
      ${message ? `<p class="message success" role="status">${escapeHtml(message)}</p>` : ''}
      <div class="boundary-note"><strong>User-provided evidence.</strong><span>This source has not been independently verified by Career Commander.</span></div>
      <section class="detail-section"><h2>What this supports</h2><p>${escapeHtml(record.description)}</p></section>
      <section class="detail-section"><h2>Provenance</h2><dl class="detail-grid"><div><dt>Source type</dt><dd>${escapeHtml(humanLabel(record.sourceType))}</dd></div><div><dt>Source title</dt><dd>${escapeHtml(record.sourceTitle || 'Not supplied')}</dd></div><div><dt>Reference</dt><dd>${escapeHtml(record.sourceReference)}</dd></div>${record.sourceUrl ? `<div><dt>URL</dt><dd><a href="${escapeHtml(record.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(record.sourceUrl)}</a></dd></div>` : ''}<div><dt>Timeframe</dt><dd>${escapeHtml(record.timeframeStart || record.timeframeEnd ? `${record.timeframeStart || 'Unknown'} to ${record.timeframeEnd || 'Present'}` : 'Not supplied')}</dd></div></dl></section>
      <section class="detail-section"><h2>Explicit relationships</h2><div class="relationship-list">${evidenceLinksText(record)}</div></section>
      ${record.notes ? `<section class="detail-section"><h2>Notes</h2><p>${escapeHtml(record.notes)}</p></section>` : ''}
      <p class="muted detail-timestamps">Created ${escapeHtml(record.createdAt)}. Updated ${escapeHtml(record.updatedAt)}.</p>
      <details class="form-section"><summary>Edit evidence</summary>${evidenceForm({ record, csrf, options, action: `/api/evidence/${encodeURIComponent(record.id)}`, next: `/evidence/${encodeURIComponent(record.id)}`, submit: 'Update evidence' })}</details>
      ${formButton(`/api/evidence/${encodeURIComponent(record.id)}/delete`, csrf, 'Delete evidence', { className: 'danger-button', extra: hidden('next', '/evidence') })}
    </section>`,
  });
}

function safeLocalNext(value, fallback = '/career-profile') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return fallback;
  const pathOnly = value.split('?')[0];
  if (pathOnly === '/career-profile' || pathOnly === '/profile' || pathOnly === '/discover' || pathOnly === '/dashboard' || pathOnly === '/evidence' || pathOnly.startsWith('/evidence/') || pathOnly === '/opportunities' || pathOnly.startsWith('/opportunities/') || pathOnly === '/applications' || pathOnly === '/onboarding' || pathOnly.startsWith('/onboarding/')) return value;
  return fallback;
}

function validationPage(title, message, back) {
  return layout({ title, body: `<section class="auth-card"><p class="eyebrow">INPUT NEEDS ATTENTION</p><h1>We could not save that yet.</h1><p class="message error" role="alert">${escapeHtml(message)}</p><p class="form-link"><a href="${escapeHtml(back)}">Return to the form</a></p></section>` });
}

function createApp({ dbPath, nodeEnv = process.env.NODE_ENV || 'development', analystProvider = null, searchProvider = null, mailboxProvider = null, companySignalsProvider = null, projectRelevanceProvider = null, reportSynthesisProvider = null, omniRoute = null } = {}) {
  const config = { secure: nodeEnv === 'production' };
  const database = new AppDatabase(dbPath || path.join(process.cwd(), 'data', 'career-commander.sqlite'));
  const authAttempts = new Map();
  const jobAnalyst = new JobAnalyst(analystProvider);
  const agents = {
    search: searchProvider || (omniRoute && typeof omniRoute.search === 'function' ? omniRoute : null),
    mailbox: mailboxProvider || null,
    companySignals: companySignalsProvider || (omniRoute && typeof omniRoute.signals === 'function' ? omniRoute : null),
    projectRelevance: projectRelevanceProvider || (omniRoute && typeof omniRoute.relevance === 'function' ? omniRoute : null),
    reportSynthesis: reportSynthesisProvider || (omniRoute && typeof omniRoute.report === 'function' ? omniRoute : null),
  };

  async function enrichAnalysis(userId, pipelineResult) {
    const projects = database.listProjectsForUser(userId).map(projectView);
    const opportunity = opportunityView(pipelineResult.opportunity);
    return buildAndSaveReport({ database, userId, opportunity, requirements: pipelineResult.requirements, matchRun: pipelineResult.matchRun, score: pipelineResult.score, gaps: pipelineResult.gaps, projects, agents });
  }

  async function analyzeOpportunityForUser(userId, opportunityId) {
    return runAutomaticAnalysis({ database, userId, opportunityId, jobAnalyst, enrich: (result) => enrichAnalysis(userId, result) });
  }

  function applicationContextForUser(userId, opportunityId) {
    const opportunity = opportunityView(database.getOpportunityByIdForUser(opportunityId, userId));
    if (!opportunity) return null;
    const requirements = database.getLatestJobRequirementsForUser(opportunityId, userId, opportunity.contentHash);
    const matchRun = database.getLatestMatchRunForUser(opportunityId, userId);
    const score = database.getLatestScoreForUser(opportunityId, userId);
    const gapRun = matchRun ? database.getGapRunForMatchRunForUser(matchRun.id, userId) : null;
    const gaps = gapRun ? database.getGapsForMatchRunForUser(matchRun.id, userId) : null;
    return {
      opportunity,
      requirements,
      matchRun,
      score,
      gapRun,
      gaps,
      profile: database.getProfileForUser(userId),
      skills: database.listSkillsForUser(userId),
      projects: database.listProjectsForUser(userId).map(projectView),
      education: database.listEducationForUser(userId),
      experience: database.listExperienceForUser(userId),
      evidence: database.listEvidenceForUser(userId),
      candidateContextFingerprint: database.getCandidateContextFingerprintForUser(userId),
    };
  }

  async function processOpportunityPayload(userId, payload) {
    const created = database.createOrReuseOpportunityForUser(userId, payload);
    database.createAuditEvent({ userId, action: created.duplicate ? 'opportunity_deduplicated' : 'opportunity_created', metadata: { opportunityId: created.opportunity.id, sourceType: payload.sourceType } });
    if (created.duplicate) database.createAuditEvent({ userId, action: 'opportunity_source_added', metadata: { opportunityId: created.opportunity.id, sourceType: payload.sourceType } });
    let analysis = null;
    if (!created.duplicate || (created.opportunity.analysisState || created.opportunity.analysis_state) !== 'COMPLETE') {
      analysis = await analyzeOpportunityForUser(userId, created.opportunity.id);
      database.createAuditEvent({ userId, action: analysis.ok ? 'opportunity_automatically_analyzed' : 'opportunity_analysis_failed', metadata: { opportunityId: created.opportunity.id, stage: analysis.stage || 'COMPLETE' } });
    }
    return { ...created, opportunity: database.getOpportunityByIdForUser(created.opportunity.id, userId), analysis };
  }

  async function runDiscovery(userId, sourceType, providerCall, metadata = {}) {
    const run = database.createDiscoveryRunForUser(userId, { sourceType, metadata });
    try {
      const output = await providerCall();
      const rawResults = resultList(output);
      const counts = { foundCount: rawResults.length, newCount: 0, duplicateCount: 0, rejectedCount: 0, analyzedCount: 0 };
      for (const raw of rawResults) {
        const normalized = normalizeDiscoveryResult(raw, sourceType === 'WEB' ? 'INTERNET' : sourceType);
        if (normalized.errors.length) { counts.rejectedCount += 1; continue; }
        try {
          const processed = await processOpportunityPayload(userId, normalized.value);
          if (processed.duplicate) counts.duplicateCount += 1;
          else counts.newCount += 1;
          if (processed.analysis?.ok) counts.analyzedCount += 1;
        } catch {
          counts.rejectedCount += 1;
        }
      }
      const status = counts.rejectedCount && (counts.newCount || counts.duplicateCount) ? 'PARTIAL' : 'COMPLETED';
      return database.finishDiscoveryRunForUser(run.id, userId, { ...counts, status });
    } catch (error) {
      return database.finishDiscoveryRunForUser(run.id, userId, { status: 'FAILED', errorMessage: error.message || 'Discovery provider unavailable.' });
    }
  }

  function getPrincipal(req) {
    const sessionToken = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!sessionToken) return null;
    const session = database.getSessionByTokenHash(hashToken(sessionToken));
    if (!session) return null;
    return {
      id: session.user_id,
      email: session.email,
      sessionId: session.id,
      sessionToken,
      tokenHash: session.token_hash,
      csrfToken: session.csrf_token,
    };
  }

  function csrfFor(req, res, principal) {
    if (principal) return principal.csrfToken;
    const existing = parseCookies(req.headers.cookie)[CSRF_COOKIE];
    if (existing) return existing;
    const token = randomToken(24);
    res.setHeader('Set-Cookie', cookie(CSRF_COOKIE, token, { secure: config.secure }));
    return token;
  }

  function authCookies(token, csrfToken) {
    return [
      cookie(SESSION_COOKIE, token, { maxAge: Math.floor(SESSION_TTL_MS / 1000), httpOnly: true, secure: config.secure }),
      cookie(CSRF_COOKIE, csrfToken, { maxAge: Math.floor(SESSION_TTL_MS / 1000), secure: config.secure }),
    ];
  }

  function clearCookies() {
    return [deletedCookie(SESSION_COOKIE, config.secure), deletedCookie(CSRF_COOKIE, config.secure)];
  }

  function createSession(userId) {
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    database.deleteSessionsForUser(userId);
    database.createSession({
      userId,
      tokenHash: hashToken(token),
      csrfToken,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    });
    return { token, csrfToken };
  }

  function csrfValid(req, body, principal) {
    const supplied = req.headers['x-csrf-token'] || body.csrf;
    const cookies = parseCookies(req.headers.cookie);
    if (!sameOrigin(req) || !supplied || !cookies[CSRF_COOKIE] || !safeEqualText(String(supplied), cookies[CSRF_COOKIE])) return false;
    if (principal && !safeEqualText(String(supplied), principal.csrfToken)) return false;
    return true;
  }

  function rejectCsrf(res, req) {
    if (isJsonRequest(req)) return sendJson(res, 403, { error: 'Invalid CSRF token.' }, {}, config);
    return sendHtml(res, 403, layout({ title: 'Request blocked', body: '<section class="auth-card"><h1>Request blocked.</h1><p class="muted">Please reload the page and try again.</p></section>' }), {}, config);
  }

  function requirePrincipal(req, res) {
    const principal = getPrincipal(req);
    if (principal) return principal;
    if (isJsonRequest(req) || req.url.startsWith('/api/')) {
      sendJson(res, 401, { error: 'Authentication required.' }, {}, config);
    } else {
      redirect(res, `/login?next=${encodeURIComponent(req.url)}`, config);
    }
    return null;
  }

  function formOrJsonError(req, res, status, message, page) {
    if (isJsonRequest(req)) return sendJson(res, status, { error: message }, {}, config);
    return sendHtml(res, status, page, {}, config);
  }

  function authRateLimited(req) {
    const key = req.socket.remoteAddress || 'unknown';
    const current = authAttempts.get(key) || { count: 0, resetAt: 0 };
    if (current.resetAt < Date.now()) return false;
    return current.count >= 10;
  }

  function recordFailedAuth(req) {
    const key = req.socket.remoteAddress || 'unknown';
    const current = authAttempts.get(key) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
    current.count += 1;
    authAttempts.set(key, current);
  }

  function mutationResponse(req, res, status, payload, redirectTo) {
    if (isJsonRequest(req)) return sendJson(res, status, payload, {}, config);
    return redirect(res, redirectTo, config);
  }

  function mutationError(req, res, status, message, back) {
    if (isJsonRequest(req)) return sendJson(res, status, { error: message }, {}, config);
    return sendHtml(res, status, validationPage('Could not save', message, back), {}, config);
  }

  async function protectedBody(req, res) {
    const current = requirePrincipal(req, res);
    if (!current) return null;
    let body;
    try {
      body = await parseBody(req);
    } catch (error) {
      mutationError(req, res, error.statusCode || 400, error.message, '/career-profile');
      return null;
    }
    if (!csrfValid(req, body, current)) {
      rejectCsrf(res, req);
      return null;
    }
    return { current, body };
  }

  function entityIdFromPath(pathname, collection) {
    const prefix = `/api/${collection}/`;
    if (!pathname.startsWith(prefix)) return null;
    const remainder = pathname.slice(prefix.length);
    if (!remainder || remainder.includes('/')) return null;
    return decodeURIComponent(remainder);
  }

  function isDeletePath(pathname, collection) {
    return new RegExp(`^/api/${collection}/[^/]+/delete$`).test(pathname);
  }

  function deleteEntityIdFromPath(pathname, collection) {
    const match = pathname.match(new RegExp(`^/api/${collection}/([^/]+)/delete$`));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function pipelineIdFromPath(pathname, action) {
    const match = pathname.match(new RegExp(`^/api/opportunities/([^/]+)/${action}$`));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function pipelineError(req, res, status, message, back) {
    return mutationError(req, res, status, message, back);
  }

  function advanceForNext(userId, next) {
    const target = safeLocalNext(next, '');
    if (!target.startsWith('/onboarding/')) return;
    const step = target.slice('/onboarding/'.length).split('?')[0];
    if (!ONBOARDING_STEPS.includes(step) || step === 'welcome') return;
    const currentProfile = database.getProfileForUser(userId);
    if (step === 'complete' && !currentProfile.name) return;
    database.updateOnboardingForUser(userId, { step, completed: step === 'complete' });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const principal = getPrincipal(req);

    if (req.method === 'GET' && pathname === '/styles.css') {
      return send(res, 200, styles, { ...securityHeaders(config), 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    }

    if (req.method === 'GET' && pathname === '/app.js') {
      return send(res, 200, clientScript, { ...securityHeaders(config), 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    }

    if (req.method === 'GET' && pathname === '/') {
      const csrf = principal ? csrfFor(req, res, principal) : '';
      return sendHtml(res, 200, landingPage({ principal, csrf }), {}, config);
    }

    if (req.method === 'GET' && pathname === '/login') {
      if (principal) return redirect(res, '/dashboard', config);
      const csrf = csrfFor(req, res, null);
      return sendHtml(res, 200, authForm({ type: 'login', csrf, next: url.searchParams.get('next') || '' }), {}, config);
    }

    if (req.method === 'GET' && pathname === '/signup') {
      if (principal) return redirect(res, '/dashboard', config);
      const csrf = csrfFor(req, res, null);
      return sendHtml(res, 200, authForm({ type: 'signup', csrf }), {}, config);
    }

    if (req.method === 'GET' && pathname === '/password-reset') {
      const csrf = csrfFor(req, res, principal);
      return sendHtml(res, 200, resetPage({ csrf, token: url.searchParams.get('token') || '' }), {}, config);
    }

    if (req.method === 'GET' && pathname === '/api/auth/csrf') {
      const csrf = csrfFor(req, res, principal);
      return sendJson(res, 200, { csrfToken: csrf }, {}, config);
    }

    if (req.method === 'GET' && pathname === '/api/auth/me') {
      if (!principal) return sendJson(res, 401, { error: 'Authentication required.' }, {}, config);
      return sendJson(res, 200, { user: { id: principal.id, email: principal.email } }, {}, config);
    }

    if (req.method === 'POST' && pathname === '/api/auth/signup') {
      let body;
      try { body = await parseBody(req); } catch (error) { return formOrJsonError(req, res, error.statusCode || 400, error.message, layout({ title: 'Create account', body: '<section class="auth-card"><h1>Unable to create account.</h1></section>' })); }
      if (!csrfValid(req, body, null)) return rejectCsrf(res, req);
      const email = normalizeEmail(body.email);
      const passwordError = validatePassword(body.password);
      if (!isValidEmail(email) || passwordError) return formOrJsonError(req, res, 400, 'Enter a valid email and password.', authForm({ type: 'signup', csrf: parseCookies(req.headers.cookie)[CSRF_COOKIE], message: 'Enter a valid email and password.' }));
      if (database.getUserByEmail(email)) return formOrJsonError(req, res, 400, 'Unable to create account with these details.', authForm({ type: 'signup', csrf: parseCookies(req.headers.cookie)[CSRF_COOKIE], message: 'Unable to create account with these details.' }));
      let user;
      try {
        user = database.createUser({ email, passwordHash: hashPassword(body.password) });
      } catch {
        return formOrJsonError(req, res, 400, 'Unable to create account with these details.', authForm({ type: 'signup', csrf: parseCookies(req.headers.cookie)[CSRF_COOKIE], message: 'Unable to create account with these details.' }));
      }
      const session = createSession(user.id);
      database.createAuditEvent({ userId: user.id, action: 'account.created', metadata: {} });
      if (isJsonRequest(req)) return sendJson(res, 201, { user: { id: user.id, email: user.email }, profileId: user.profileId, next: '/onboarding' }, { 'Set-Cookie': authCookies(session.token, session.csrfToken) }, config);
      return redirect(res, '/onboarding', config, { 'Set-Cookie': authCookies(session.token, session.csrfToken) });
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      let body;
      try { body = await parseBody(req); } catch (error) { return formOrJsonError(req, res, error.statusCode || 400, error.message, authForm({ type: 'login', csrf: parseCookies(req.headers.cookie)[CSRF_COOKIE], message: 'Unable to log in.' })); }
      if (!csrfValid(req, body, null)) return rejectCsrf(res, req);
      if (authRateLimited(req)) return formOrJsonError(req, res, 429, 'Too many login attempts. Try again later.', authForm({ type: 'login', csrf: parseCookies(req.headers.cookie)[CSRF_COOKIE], message: 'Too many login attempts. Try again later.' }));
      const email = normalizeEmail(body.email);
      const user = database.getUserByEmail(email);
      const valid = verifyPassword(body.password || '', user ? user.password_hash : DUMMY_PASSWORD_HASH);
      if (!user || !valid) {
        recordFailedAuth(req);
        return formOrJsonError(req, res, 401, 'Invalid email or password.', authForm({ type: 'login', csrf: parseCookies(req.headers.cookie)[CSRF_COOKIE], message: 'Invalid email or password.' }));
      }
      const session = createSession(user.id);
      database.createAuditEvent({ userId: user.id, action: 'auth.login', metadata: {} });
      if (isJsonRequest(req)) return sendJson(res, 200, { user: publicUser(user) }, { 'Set-Cookie': authCookies(session.token, session.csrfToken) }, config);
      return redirect(res, '/dashboard', config, { 'Set-Cookie': authCookies(session.token, session.csrfToken) });
    }

    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      let body;
      try { body = await parseBody(req); } catch (error) { return sendJson(res, 400, { error: error.message }, {}, config); }
      if (principal && !csrfValid(req, body, principal)) return rejectCsrf(res, req);
      if (principal) {
        database.createAuditEvent({ userId: principal.id, action: 'auth.logout', metadata: {} });
        database.deleteSessionByTokenHash(principal.tokenHash);
      }
      if (isJsonRequest(req)) return sendJson(res, 204, null, { 'Set-Cookie': clearCookies() }, config);
      return redirect(res, '/login', config, { 'Set-Cookie': clearCookies() });
    }

    if (req.method === 'POST' && pathname === '/api/auth/password-reset/request') {
      let body;
      try { body = await parseBody(req); } catch (error) { return sendJson(res, 400, { error: error.message }, {}, config); }
      if (!csrfValid(req, body, null)) return rejectCsrf(res, req);
      const email = normalizeEmail(body.email);
      const user = database.getUserByEmail(email);
      let resetToken;
      if (user) {
        resetToken = randomToken(32);
        database.createPasswordReset({ userId: user.id, tokenHash: hashToken(resetToken), expiresAt: new Date(Date.now() + RESET_TTL_MS).toISOString() });
        database.createAuditEvent({ userId: user.id, action: 'auth.password_reset_requested', metadata: {} });
      }
      const response = { message: 'If an account matches that email, reset instructions have been prepared.' };
      if (nodeEnv !== 'production' && resetToken) response.resetToken = resetToken;
      if (isJsonRequest(req)) return sendJson(res, 200, response, {}, config);
      const message = nodeEnv !== 'production' && resetToken ? 'Reset instructions prepared for this development environment.' : 'If an account matches that email, reset instructions have been prepared.';
      return sendHtml(res, 200, resetPage({ csrf: parseCookies(req.headers.cookie)[CSRF_COOKIE], message, sent: true }), {}, config);
    }

    if (req.method === 'POST' && pathname === '/api/auth/password-reset/confirm') {
      let body;
      try { body = await parseBody(req); } catch (error) { return sendJson(res, 400, { error: error.message }, {}, config); }
      if (!csrfValid(req, body, null)) return rejectCsrf(res, req);
      const passwordError = validatePassword(body.password);
      if (!body.token || passwordError) return formOrJsonError(req, res, 400, passwordError || 'Invalid reset token.', resetPage({ csrf: parseCookies(req.headers.cookie)[CSRF_COOKIE], token: body.token, message: passwordError || 'Invalid or expired reset link.' }));
      const userId = database.consumePasswordReset(hashToken(body.token));
      if (!userId) return formOrJsonError(req, res, 400, 'Invalid or expired reset link.', resetPage({ csrf: parseCookies(req.headers.cookie)[CSRF_COOKIE], token: body.token, message: 'Invalid or expired reset link.' }));
      database.updatePassword(userId, hashPassword(body.password));
      database.deleteSessionsForUser(userId);
      database.createAuditEvent({ userId, action: 'auth.password_reset_completed', metadata: {} });
      if (isJsonRequest(req)) return sendJson(res, 200, { message: 'Password reset successfully.' }, { 'Set-Cookie': clearCookies() }, config);
      return redirect(res, '/login?reset=complete', config, { 'Set-Cookie': clearCookies() });
    }

    if ((req.method === 'POST' || req.method === 'PUT') && pathname === '/api/profile') {
      const context = await protectedBody(req, res);
      if (!context) return;
      const result = validateProfile(context.body);
      if (result.errors.length) return mutationError(req, res, 400, result.errors.join(' '), safeLocalNext(context.body.next, '/career-profile'));
      const saved = database.updateProfileForUser(context.current.id, result.value);
      advanceForNext(context.current.id, context.body.next);
      database.createAuditEvent({ userId: context.current.id, action: 'profile.updated', metadata: { profileId: saved.id } });
      return mutationResponse(req, res, 200, { profile: apiProfile(saved) }, safeLocalNext(context.body.next, '/career-profile'));
    }

    if (req.method === 'POST' && pathname === '/api/discover/manual') {
      const context = await protectedBody(req, res);
      if (!context) return;
      const back = safeLocalNext(context.body.next, '/discover');
      const result = toOpportunityPayload({ ...context.body, sourceType: 'MANUAL' });
      if (result.errors.length) return pipelineError(req, res, 400, result.errors.join(' '), back);
      const run = database.createDiscoveryRunForUser(context.current.id, { sourceType: 'MANUAL', metadata: { intake: 'manual' } });
      try {
        const processed = await processOpportunityPayload(context.current.id, result.value);
        const savedRun = database.finishDiscoveryRunForUser(run.id, context.current.id, { status: processed.analysis && !processed.analysis.ok ? 'PARTIAL' : 'COMPLETED', foundCount: 1, newCount: processed.duplicate ? 0 : 1, duplicateCount: processed.duplicate ? 1 : 0, analyzedCount: processed.analysis?.ok ? 1 : 0 });
        return mutationResponse(req, res, 201, { run: savedRun, opportunity: apiOpportunity(processed.opportunity), duplicate: processed.duplicate, analysis: processed.analysis }, back.includes('?') ? back : `${back}?saved=manual`);
      } catch (error) {
        const savedRun = database.finishDiscoveryRunForUser(run.id, context.current.id, { status: 'FAILED', foundCount: 1, rejectedCount: 1, errorMessage: 'The opportunity was not processed after intake.' });
        return pipelineError(req, res, 500, `The opportunity was preserved but could not be processed. Run ${savedRun.id} can be retried from the opportunity report.`, back);
      }
    }

    if (req.method === 'POST' && pathname === '/api/discover/email/connect') {
      const context = await protectedBody(req, res);
      if (!context) return;
      const provider = String(context.body.provider || '').trim().toUpperCase();
      if (!['GMAIL', 'OUTLOOK', 'MOCK'].includes(provider)) return mutationError(req, res, 400, 'Choose Gmail, Outlook, or Mock as the mailbox adapter.', '/discover#email');
      const connection = database.saveMailboxConnectionForUser(context.current.id, { provider, status: 'CONFIGURED', accountLabel: String(context.body.accountLabel || '').trim().slice(0, 180), metadata: { configuredAt: new Date().toISOString() } });
      database.createAuditEvent({ userId: context.current.id, action: 'mailbox.configured', metadata: { provider } });
      return mutationResponse(req, res, 200, { connection }, '/discover#email');
    }

    if (req.method === 'POST' && pathname === '/api/discover/web/scan') {
      const context = await protectedBody(req, res);
      if (!context) return;
      const profile = database.getProfileForUser(context.current.id);
      const skills = database.listSkillsForUser(context.current.id);
      if (!agents.search) {
        const run = database.createDiscoveryRunForUser(context.current.id, { sourceType: 'WEB', metadata: { queries: buildSearchQueries(profile, skills) } });
        const failed = database.finishDiscoveryRunForUser(run.id, context.current.id, { status: 'FAILED', errorMessage: 'OmniRoute search provider unavailable.' });
        return pipelineError(req, res, 503, `Web scan failed. OmniRoute search provider unavailable. Your existing opportunities remain safe. Run ${failed.id} can be retried.`, '/discover');
      }
      const contextProfile = discoveryProfileView(profile, skills);
      const queries = buildSearchQueries(profile, skills);
      const providerCall = typeof agents.search === 'function' ? () => agents.search({ queries, profile: contextProfile }) : () => agents.search.search({ queries, profile: contextProfile });
      const run = await runDiscovery(context.current.id, 'WEB', providerCall, { queries });
      database.createAuditEvent({ userId: context.current.id, action: run.status === 'FAILED' ? 'web_scan_failed' : 'web_scan_completed', metadata: { runId: run.id, resultCount: run.foundCount } });
      if (run.status === 'FAILED') return pipelineError(req, res, 503, `Web scan failed. ${run.errorMessage} Your existing opportunities remain safe.`, '/discover');
      return mutationResponse(req, res, 200, { run, queries }, '/discover?saved=web');
    }

    if (req.method === 'POST' && pathname === '/api/discover/email/scan') {
      const context = await protectedBody(req, res);
      if (!context) return;
      const connection = database.getMailboxConnectionForUser(context.current.id);
      if (!connection) return pipelineError(req, res, 409, 'Configure a mailbox adapter before scanning email.', '/discover#email');
      if (!agents.mailbox) {
        const run = database.createDiscoveryRunForUser(context.current.id, { sourceType: 'EMAIL', metadata: { provider: connection.provider } });
        const failed = database.finishDiscoveryRunForUser(run.id, context.current.id, { status: 'FAILED', errorMessage: 'Mailbox adapter unavailable.' });
        return pipelineError(req, res, 503, `Email scan incomplete. ${connection.provider} mailbox adapter unavailable. Previously discovered opportunities are unchanged. Run ${failed.id} can be retried.`, '/discover#email');
      }
      const profile = discoveryProfileView(database.getProfileForUser(context.current.id), database.listSkillsForUser(context.current.id));
      const providerCall = typeof agents.mailbox === 'function' ? () => agents.mailbox({ connection, profile }) : () => agents.mailbox.scan({ connection, profile });
      const run = await runDiscovery(context.current.id, 'EMAIL', providerCall, { provider: connection.provider });
      database.createAuditEvent({ userId: context.current.id, action: run.status === 'FAILED' ? 'email_scan_failed' : 'email_scan_completed', metadata: { runId: run.id, resultCount: run.foundCount } });
      if (run.status === 'FAILED') return pipelineError(req, res, 503, `Email scan incomplete. ${run.errorMessage} Previously discovered opportunities are unchanged.`, '/discover#email');
      return mutationResponse(req, res, 200, { run }, '/discover?saved=email');
    }

    const roadmapStatusMatch = pathname.match(/^\/api\/roadmap-items\/([^/]+)\/status$/);
    if (req.method === 'POST' && roadmapStatusMatch) {
      const context = await protectedBody(req, res);
      if (!context) return;
      const back = safeLocalNext(context.body.next, '/opportunities');
      const item = database.updateRoadmapItemStatusForUser(decodeURIComponent(roadmapStatusMatch[1]), context.current.id, String(context.body.status || '').trim().toUpperCase());
      if (!item) return pipelineError(req, res, 404, 'Roadmap item not found or status is invalid.', back);
      database.createAuditEvent({ userId: context.current.id, action: 'roadmap_status_updated', metadata: { roadmapItemId: item.id, status: item.status } });
      return mutationResponse(req, res, 200, { roadmap: apiRoadmap(item) }, back);
    }

    const roadmapEvidenceMatch = pathname.match(/^\/api\/roadmap-items\/([^/]+)\/evidence$/);
    if (req.method === 'POST' && roadmapEvidenceMatch) {
      const context = await protectedBody(req, res);
      if (!context) return;
      const back = safeLocalNext(context.body.next, '/opportunities');
      const linked = database.linkEvidenceToRoadmapItemForUser(context.current.id, decodeURIComponent(roadmapEvidenceMatch[1]), String(context.body.evidenceId || '').trim());
      if (!linked) return pipelineError(req, res, 404, 'Roadmap item or evidence record not found.', back);
      database.createAuditEvent({ userId: context.current.id, action: 'roadmap_evidence_linked', metadata: { roadmapItemId: linked.roadmapItemId, evidenceId: String(context.body.evidenceId || '') } });
      return mutationResponse(req, res, 200, { roadmap: linked }, back);
    }

    const roadmapEvidenceUnlinkMatch = pathname.match(/^\/api\/roadmap-items\/([^/]+)\/evidence\/([^/]+)\/unlink$/);
    if (req.method === 'POST' && roadmapEvidenceUnlinkMatch) {
      const context = await protectedBody(req, res);
      if (!context) return;
      const back = safeLocalNext(context.body.next, '/opportunities');
      const unlinked = database.unlinkEvidenceFromRoadmapItemForUser(context.current.id, decodeURIComponent(roadmapEvidenceUnlinkMatch[1]), decodeURIComponent(roadmapEvidenceUnlinkMatch[2]));
      if (!unlinked) return pipelineError(req, res, 404, 'Roadmap item not found.', back);
      database.createAuditEvent({ userId: context.current.id, action: 'roadmap_evidence_unlinked', metadata: { roadmapItemId: unlinked.roadmapItemId, evidenceId: decodeURIComponent(roadmapEvidenceUnlinkMatch[2]), deleted: unlinked.deleted } });
      return mutationResponse(req, res, 200, { roadmap: unlinked }, back);
    }

    const roadmapGenerateMatch = pathname.match(/^\/api\/opportunities\/([^/]+)\/roadmap\/generate$/);
    if (req.method === 'POST' && roadmapGenerateMatch) {
      const context = await protectedBody(req, res);
      if (!context) return;
      const back = safeLocalNext(context.body.next, `/opportunities/${roadmapGenerateMatch[1]}`);
      const analyzed = applicationContextForUser(context.current.id, decodeURIComponent(roadmapGenerateMatch[1]));
      if (!analyzed) return pipelineError(req, res, 404, 'Resource not found.', back);
      if (!analyzed.gaps) return pipelineError(req, res, 409, 'Complete deterministic gap analysis before generating a roadmap.', back);
      const roadmap = database.replaceRoadmapItemsForUser(context.current.id, analyzed.opportunity.id, roadmapForGaps(analyzed.gaps));
      database.createAuditEvent({ userId: context.current.id, action: 'roadmap_generated', metadata: { opportunityId: analyzed.opportunity.id, gapCount: analyzed.gaps.length } });
      return mutationResponse(req, res, 200, { roadmap: roadmap.map(apiRoadmap) }, back);
    }

    const applicationCreateMatch = pathname.match(/^\/api\/opportunities\/([^/]+)\/application$/);
    if (req.method === 'POST' && applicationCreateMatch) {
      const context = await protectedBody(req, res);
      if (!context) return;
      const back = safeLocalNext(context.body.next, `/opportunities/${applicationCreateMatch[1]}`);
      const analyzed = applicationContextForUser(context.current.id, decodeURIComponent(applicationCreateMatch[1]));
      if (!analyzed) return pipelineError(req, res, 404, 'Resource not found.', back);
      if (!analyzed.requirements || !analyzed.matchRun || !analyzed.score || !analyzed.gaps) return pipelineError(req, res, 409, 'Complete the deterministic opportunity analysis before preparing an application.', back);
      const existing = database.getApplicationForOpportunityForUser(analyzed.opportunity.id, context.current.id);
      if (existing) return mutationResponse(req, res, 200, { application: apiApplication(existing), existing: true }, `/applications/${encodeURIComponent(existing.id)}`);
      const draftText = buildApplicationDraft(analyzed);
      const claims = groundClaims(draftText, analyzed);
      const sourceSnapshot = applicationSourceSnapshot(analyzed);
      const application = database.createApplicationForUser(context.current.id, { opportunityId: analyzed.opportunity.id, draftText, provider: 'deterministic-profile-evidence-draft', claimSummary: summarizeClaims(claims), sourceSnapshot });
      const saved = database.replaceApplicationClaimsForUser(context.current.id, application.id, claims, summarizeClaims(claims));
      database.createAuditEvent({ userId: context.current.id, action: 'application_draft_created', metadata: { applicationId: saved.id, opportunityId: analyzed.opportunity.id } });
      return mutationResponse(req, res, 201, { application: apiApplication(saved) }, `/applications/${encodeURIComponent(saved.id)}`);
    }

    const applicationUpdateMatch = pathname.match(/^\/api\/applications\/([^/]+)$/);
    if (req.method === 'POST' && applicationUpdateMatch) {
      const context = await protectedBody(req, res);
      if (!context) return;
      const id = decodeURIComponent(applicationUpdateMatch[1]);
      const current = database.getApplicationForUser(id, context.current.id);
      if (!current) return pipelineError(req, res, 404, 'Resource not found.', '/applications');
      const back = safeLocalNext(context.body.next, `/applications/${encodeURIComponent(id)}`);
      const draftText = String(context.body.draftText || '').trim();
      if (!draftText || draftText.length > 20000) return pipelineError(req, res, 400, 'Application draft is required and must be 20,000 characters or fewer.', back);
      const analyzed = applicationContextForUser(context.current.id, current.opportunityId);
      if (!analyzed) return pipelineError(req, res, 409, 'The opportunity context is no longer available. Refresh this application from its opportunity.', back);
      const claims = groundClaims(draftText, analyzed);
      const analysisReady = Boolean(analyzed.requirements && analyzed.matchRun && analyzed.score && analyzed.gaps);
      const saved = database.updateApplicationForUser(id, context.current.id, { draftText, claimSummary: summarizeClaims(claims), sourceSnapshot: applicationSourceSnapshot(analyzed), stale: !analysisReady, staleReason: analysisReady ? '' : 'Underlying opportunity analysis must be refreshed before this draft is current.' });
      const checked = database.replaceApplicationClaimsForUser(context.current.id, id, claims, summarizeClaims(claims));
      const finalApplication = !analysisReady ? database.updateApplicationForUser(id, context.current.id, { stale: true, staleReason: 'Underlying opportunity analysis must be refreshed before this draft is current.' }) : checked || saved;
      database.createAuditEvent({ userId: context.current.id, action: 'application_draft_updated', metadata: { applicationId: id } });
      return mutationResponse(req, res, 200, { application: apiApplication(finalApplication) }, back);
    }

    const applicationReviewMatch = pathname.match(/^\/api\/applications\/([^/]+)\/review$/);
    if (req.method === 'POST' && applicationReviewMatch) {
      const context = await protectedBody(req, res);
      if (!context) return;
      const id = decodeURIComponent(applicationReviewMatch[1]);
      const current = database.getApplicationForUser(id, context.current.id);
      if (!current) return pipelineError(req, res, 404, 'Resource not found.', '/applications');
      const back = safeLocalNext(context.body.next, `/applications/${encodeURIComponent(id)}`);
      const analyzed = applicationContextForUser(context.current.id, current.opportunityId);
      if (!analyzed || applicationFreshness(current, analyzed).isStale) return pipelineError(req, res, 409, 'This draft is stale. Save it again to re-check claims against the current profile, evidence, and opportunity analysis before review.', back);
      const saved = database.updateApplicationForUser(id, context.current.id, { status: 'READY_FOR_REVIEW', reviewNote: String(context.body.reviewNote || '').trim().slice(0, 2000) });
      database.createAuditEvent({ userId: context.current.id, action: 'application_marked_ready_for_review', metadata: { applicationId: id } });
      return mutationResponse(req, res, 200, { application: apiApplication(saved) }, back);
    }

    const opportunityId = entityIdFromPath(pathname, 'opportunities') || deleteEntityIdFromPath(pathname, 'opportunities');
    const opportunityDeleteRequest = req.method === 'DELETE' || isDeletePath(pathname, 'opportunities');
    if (opportunityId || pathname === '/api/opportunities') {
      if ((req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT' || req.method === 'DELETE') && (pathname === '/api/opportunities' || opportunityId)) {
        const context = await protectedBody(req, res);
        if (!context) return;
        const back = safeLocalNext(context.body.next, '/opportunities');
        if (opportunityDeleteRequest) {
          if (!opportunityId) return pipelineError(req, res, 400, 'An opportunity ID is required.', back);
          if (!database.getOpportunityByIdForUser(opportunityId, context.current.id)) return pipelineError(req, res, 404, 'Resource not found.', back);
          database.deleteOpportunityForUser(opportunityId, context.current.id);
          database.createAuditEvent({ userId: context.current.id, action: 'opportunity_deleted', metadata: { opportunityId } });
          return mutationResponse(req, res, 204, null, '/opportunities');
        }
        const existingRow = opportunityId ? database.getOpportunityByIdForUser(opportunityId, context.current.id) : null;
        const existing = opportunityView(existingRow);
        if (opportunityId && !existing) return pipelineError(req, res, 404, 'Resource not found.', back);
        const result = toOpportunityPayload({ ...context.body, lifecycleStatus: context.body.lifecycleStatus || existing?.lifecycleStatus });
        if (result.errors.length) return pipelineError(req, res, 400, result.errors.join(' '), back);
        try {
          if (opportunityId) {
            const saved = database.updateOpportunityForUser(opportunityId, context.current.id, result.value);
            database.createAuditEvent({ userId: context.current.id, action: 'opportunity_updated', metadata: { opportunityId: saved.id } });
            return mutationResponse(req, res, 200, { opportunity: apiOpportunity(saved) }, back);
          }
          const created = database.createOrReuseOpportunityForUser(context.current.id, result.value);
          database.createAuditEvent({ userId: context.current.id, action: created.duplicate ? 'opportunity_deduplicated' : 'opportunity_created', metadata: { opportunityId: created.opportunity.id, sourceType: result.value.sourceType } });
          if (created.duplicate) database.createAuditEvent({ userId: context.current.id, action: 'opportunity_source_added', metadata: { opportunityId: created.opportunity.id, sourceType: result.value.sourceType } });
          return mutationResponse(req, res, created.duplicate ? 200 : 201, { opportunity: apiOpportunity(created.opportunity), duplicate: created.duplicate }, created.duplicate ? `/opportunities/${created.opportunity.id}?saved=duplicate` : '/opportunities?saved=1');
        } catch (error) {
          if (error.code === 'DUPLICATE_OPPORTUNITY' || /UNIQUE/i.test(error.message || '')) return pipelineError(req, res, 409, 'That opportunity is already represented in this account.', back);
          throw error;
        }
      }
    }

    const analyzeOpportunityId = pipelineIdFromPath(pathname, 'analyze');
    if (req.method === 'POST' && analyzeOpportunityId) {
      const context = await protectedBody(req, res);
      if (!context) return;
      const back = safeLocalNext(context.body.next, `/opportunities/${analyzeOpportunityId}`);
      const opportunity = opportunityView(database.getOpportunityByIdForUser(analyzeOpportunityId, context.current.id));
      if (!opportunity) return pipelineError(req, res, 404, 'Resource not found.', back);
      try {
        const analysis = await jobAnalyst.analyze(opportunity.rawContent);
        const saved = database.createJobRequirementsForUser(context.current.id, {
          opportunityId: opportunity.id,
          contentHash: opportunity.contentHash,
          requirements: analysis.requirements,
          rawOutput: analysis.rawOutput,
          provider: analysis.provider,
          model: analysis.model,
          analystVersion: analysis.analysisVersion,
        });
        database.setOpportunityLifecycleStatusForUser(opportunity.id, context.current.id, 'ANALYZED');
        database.updateOpportunityAnalysisForUser(opportunity.id, context.current.id, 'REQUIREMENTS_READY');
        database.createAuditEvent({ userId: context.current.id, action: 'job_requirements_created', metadata: { opportunityId: opportunity.id, jobRequirementsId: saved.id, analystVersion: saved.analystVersion } });
        return mutationResponse(req, res, 201, { requirements: apiRequirements(saved) }, back.includes('?') ? back : `${back}?saved=analysis`);
      } catch (error) {
        const message = error instanceof AnalystOutputError ? `The analyst output was not valid: ${error.message}` : error instanceof AnalystProviderError ? error.message : 'The job analysis could not be completed.';
        database.createFailedJobRequirementsForUser(context.current.id, { opportunityId: opportunity.id, contentHash: opportunity.contentHash, requirementsVersion: JOB_REQUIREMENTS_VERSION, analystVersion: ANALYST_VERSION, errorMessage: message });
        database.updateOpportunityAnalysisForUser(opportunity.id, context.current.id, 'FAILED_ANALYST', message);
        database.createAuditEvent({ userId: context.current.id, action: 'job_requirements_failed', metadata: { opportunityId: opportunity.id } });
        return pipelineError(req, res, error instanceof AnalystProviderError ? 503 : 422, message, back);
      }
    }

    const matchOpportunityId = pipelineIdFromPath(pathname, 'match');
    if (req.method === 'POST' && matchOpportunityId) {
      const context = await protectedBody(req, res);
      if (!context) return;
      const back = safeLocalNext(context.body.next, `/opportunities/${matchOpportunityId}`);
      const opportunity = opportunityView(database.getOpportunityByIdForUser(matchOpportunityId, context.current.id));
      const requirements = opportunity && database.getLatestJobRequirementsForUser(matchOpportunityId, context.current.id, opportunity.contentHash);
      if (!opportunity) return pipelineError(req, res, 404, 'Resource not found.', back);
      if (!requirements) return pipelineError(req, res, 409, 'Analyze this opportunity before matching evidence.', back);
      const result = matchRequirements({ requirements: requirements.requirements, skills: database.listSkillsForUser(context.current.id), evidence: database.listEvidenceForUser(context.current.id) });
      const run = database.createMatchRunForUser(context.current.id, { opportunityId: opportunity.id, jobRequirementsId: requirements.id, matcherVersion: result.matcherVersion, results: result.results });
      database.updateOpportunityAnalysisForUser(opportunity.id, context.current.id, 'MATCHED');
      database.createAuditEvent({ userId: context.current.id, action: 'match_results_created', metadata: { opportunityId: opportunity.id, matchRunId: run.id } });
      return mutationResponse(req, res, 201, { matchRun: run }, back.includes('?') ? back : `${back}?saved=match`);
    }

    const scoreOpportunityId = pipelineIdFromPath(pathname, 'score');
    if (req.method === 'POST' && scoreOpportunityId) {
      const context = await protectedBody(req, res);
      if (!context) return;
      const back = safeLocalNext(context.body.next, `/opportunities/${scoreOpportunityId}`);
      const opportunity = opportunityView(database.getOpportunityByIdForUser(scoreOpportunityId, context.current.id));
      const requirements = opportunity && database.getLatestJobRequirementsForUser(scoreOpportunityId, context.current.id, opportunity.contentHash);
      const run = opportunity && database.getLatestMatchRunForUser(scoreOpportunityId, context.current.id);
      if (!opportunity) return pipelineError(req, res, 404, 'Resource not found.', back);
      if (!requirements || !run || run.jobRequirementsId !== requirements.id) return pipelineError(req, res, 409, 'Match evidence before calculating a score.', back);
      const score = scoreMatchResults(run.results);
      const saved = database.createScoreBreakdownForUser(context.current.id, { opportunityId: opportunity.id, matchRunId: run.id, jobRequirementsId: requirements.id, formulaVersion: SCORE_FORMULA_VERSION, score });
      database.updateOpportunityAnalysisForUser(opportunity.id, context.current.id, 'SCORED');
      database.createAuditEvent({ userId: context.current.id, action: 'score_breakdown_created', metadata: { opportunityId: opportunity.id, matchRunId: run.id } });
      return mutationResponse(req, res, 201, { score: saved }, back.includes('?') ? back : `${back}?saved=score`);
    }

    const gapsOpportunityId = pipelineIdFromPath(pathname, 'gaps');
    if (req.method === 'POST' && gapsOpportunityId) {
      const context = await protectedBody(req, res);
      if (!context) return;
      const back = safeLocalNext(context.body.next, `/opportunities/${gapsOpportunityId}`);
      const opportunity = opportunityView(database.getOpportunityByIdForUser(gapsOpportunityId, context.current.id));
      const requirements = opportunity && database.getLatestJobRequirementsForUser(gapsOpportunityId, context.current.id, opportunity.contentHash);
      const run = opportunity && database.getLatestMatchRunForUser(gapsOpportunityId, context.current.id);
      const score = opportunity && database.getLatestScoreForUser(gapsOpportunityId, context.current.id);
      if (!opportunity) return pipelineError(req, res, 404, 'Resource not found.', back);
      if (!run || !score || score.matchRunId !== run.id) return pipelineError(req, res, 409, 'Calculate a score before analyzing gaps.', back);
      const result = analyzeGaps({ matchResults: run.results });
      const saved = database.createGapsForUser(context.current.id, { opportunityId: opportunity.id, matchRunId: run.id, logicVersion: result.logicVersion, gaps: result.gaps });
      database.updateOpportunityAnalysisForUser(opportunity.id, context.current.id, 'COMPLETE');
      await buildAndSaveReport({ database, userId: context.current.id, opportunity, requirements: database.getLatestJobRequirementsForUser(opportunity.id, context.current.id, opportunity.contentHash), matchRun: run, score, gaps: saved.gaps, projects: database.listProjectsForUser(context.current.id).map(projectView), agents });
      database.createAuditEvent({ userId: context.current.id, action: 'gaps_created', metadata: { opportunityId: opportunity.id, matchRunId: run.id, gapCount: saved.gaps.length } });
      return mutationResponse(req, res, 201, { gapRun: saved.run, gaps: saved.gaps }, back.includes('?') ? back : `${back}?saved=gaps`);
    }

    const evidenceId = entityIdFromPath(pathname, 'evidence') || deleteEntityIdFromPath(pathname, 'evidence');
    const evidenceDeleteRequest = req.method === 'DELETE' || isDeletePath(pathname, 'evidence');
    if (evidenceId || pathname === '/api/evidence') {
      if ((req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT' || req.method === 'DELETE') && (pathname === '/api/evidence' || evidenceId)) {
        const context = await protectedBody(req, res);
        if (!context) return;
        const back = safeLocalNext(context.body.next, '/evidence');
        if (evidenceDeleteRequest) {
          if (!evidenceId) return mutationError(req, res, 400, 'An evidence ID is required.', back);
          const existing = database.getEvidenceByIdForUser(evidenceId, context.current.id);
          if (!existing) return mutationError(req, res, 404, 'Resource not found.', back);
          database.deleteEvidenceForUser(evidenceId, context.current.id);
          database.createAuditEvent({ userId: context.current.id, action: 'evidence_deleted', metadata: { evidenceId } });
          return mutationResponse(req, res, 204, null, '/evidence');
        }
        if (evidenceId && !database.getEvidenceByIdForUser(evidenceId, context.current.id)) return mutationError(req, res, 404, 'Resource not found.', back);
        const result = validateEvidence(context.body);
        if (result.errors.length) return mutationError(req, res, 400, result.errors.join(' '), back);
        try {
          const before = evidenceId ? database.getEvidenceByIdForUser(evidenceId, context.current.id) : null;
          const saved = evidenceId
            ? database.updateEvidenceForUser(evidenceId, context.current.id, result.value)
            : database.createEvidenceForUser(context.current.id, result.value);
          if (!saved) return mutationError(req, res, 404, 'Resource not found.', back);
          database.createAuditEvent({ userId: context.current.id, action: evidenceId ? 'evidence_updated' : 'evidence_created', metadata: { evidenceId: saved.id } });
          const changes = evidenceLinkChanges(before?.links || [], saved.links || []);
          for (const link of changes.linked) database.createAuditEvent({ userId: context.current.id, action: 'evidence_linked', metadata: { evidenceId: saved.id, entityType: link.entityType, entityId: link.entityId } });
          for (const link of changes.unlinked) database.createAuditEvent({ userId: context.current.id, action: 'evidence_unlinked', metadata: { evidenceId: saved.id, entityType: link.entityType, entityId: link.entityId } });
          return mutationResponse(req, res, evidenceId ? 200 : 201, { evidence: apiEvidence(saved) }, back);
        } catch (error) {
          if (error.code === 'INVALID_EVIDENCE_LINK') return mutationError(req, res, 400, 'Choose related records from your account.', back);
          if (/CHECK constraint/i.test(error.message || '')) return mutationError(req, res, 400, 'The evidence values are not valid.', back);
          throw error;
        }
      }
    }

    const entityConfigs = {
      education: { validate: validateEducation, create: 'createEducation', update: 'updateEducationForUser', remove: 'deleteEducationForUser', get: 'getEducationByIdForUser', list: 'listEducationForUser', serialize: apiEducation, audit: 'education' },
      skills: { validate: validateSkill, create: 'createSkill', update: 'updateSkillForUser', remove: 'deleteSkillForUser', get: 'getSkillByIdForUser', list: 'listSkillsForUser', serialize: apiSkill, audit: 'skill' },
      projects: { validate: validateProject, create: 'createProject', update: 'updateProjectForUser', remove: 'deleteProjectForUser', get: 'getProjectByIdForUser', list: 'listProjectsForUser', serialize: apiProject, audit: 'project' },
      experience: { validate: validateExperience, create: 'createExperience', update: 'updateExperienceForUser', remove: 'deleteExperienceForUser', get: 'getExperienceByIdForUser', list: 'listExperienceForUser', serialize: apiExperience, audit: 'experience' },
    };
    const entityMatch = Object.entries(entityConfigs).find(([collection]) => pathname === `/api/${collection}` || entityIdFromPath(pathname, collection) || isDeletePath(pathname, collection));
    if (entityMatch && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
      const [collection, entity] = entityMatch;
      const context = await protectedBody(req, res);
      if (!context) return;
      const id = entityIdFromPath(pathname, collection) || deleteEntityIdFromPath(pathname, collection);
      const deleteRequest = req.method === 'DELETE' || isDeletePath(pathname, collection);
      if (deleteRequest) {
        if (!id) return mutationError(req, res, 400, 'A record ID is required.', '/career-profile');
        const deleted = database[entity.remove](id, context.current.id);
        if (!deleted) return mutationError(req, res, 404, 'Resource not found.', safeLocalNext(context.body.next, '/career-profile'));
        database.createAuditEvent({ userId: context.current.id, action: `${entity.audit}.deleted`, metadata: { recordId: id } });
        return mutationResponse(req, res, 204, null, safeLocalNext(context.body.next, '/career-profile'));
      }
      if (id && !database[entity.get](id, context.current.id)) return mutationError(req, res, 404, 'Resource not found.', safeLocalNext(context.body.next, '/career-profile'));
      const result = entity.validate(context.body);
      if (result.errors.length) return mutationError(req, res, 400, result.errors.join(' '), safeLocalNext(context.body.next, '/career-profile'));
      try {
        const saved = id
          ? database[entity.update](id, context.current.id, result.value)
          : database[entity.create](context.current.id, result.value);
        if (!saved) return mutationError(req, res, 404, 'Resource not found.', safeLocalNext(context.body.next, '/career-profile'));
        advanceForNext(context.current.id, context.body.next);
        database.createAuditEvent({ userId: context.current.id, action: `${entity.audit}.${id ? 'updated' : 'created'}`, metadata: { recordId: saved.id } });
        return mutationResponse(req, res, id ? 200 : 201, { [collection]: entity.serialize(saved) }, safeLocalNext(context.body.next, '/career-profile'));
      } catch (error) {
        if (/UNIQUE/i.test(error.message || '')) return mutationError(req, res, 400, 'That record already exists for this account.', safeLocalNext(context.body.next, '/career-profile'));
        throw error;
      }
    }

    if ((req.method === 'POST' || req.method === 'PATCH') && pathname === '/api/onboarding') {
      const context = await protectedBody(req, res);
      if (!context) return;
      const step = String(context.body.step || '').trim();
      if (!ONBOARDING_STEPS.includes(step) || step === 'welcome') return mutationError(req, res, 400, 'Choose a valid onboarding step.', '/onboarding');
      const currentProfile = database.getProfileForUser(context.current.id);
      if (step === 'complete' && !currentProfile.name) return mutationError(req, res, 400, 'Complete the required profile name before finishing onboarding.', '/onboarding/profile');
      const updated = database.updateOnboardingForUser(context.current.id, { step, completed: step === 'complete' });
      database.createAuditEvent({ userId: context.current.id, action: step === 'complete' ? 'onboarding.completed' : 'onboarding.progressed', metadata: { step } });
      return mutationResponse(req, res, 200, { onboarding: { step, completed: step === 'complete', completionState: completionState(updated) } }, step === 'complete' ? '/dashboard' : `/onboarding/${step}`);
    }

    if (req.method === 'GET' && pathname.startsWith('/api/')) {
      const current = requirePrincipal(req, res);
      if (!current) return;
      if (pathname === '/api/discovery/runs') return sendJson(res, 200, { runs: database.listDiscoveryRunsForUser(current.id) }, {}, config);
      if (pathname === '/api/profile') return sendJson(res, 200, { profile: apiProfile(database.getProfileForUser(current.id)) }, {}, config);
      if (pathname.startsWith('/api/profiles/')) {
        const profileId = pathname.slice('/api/profiles/'.length);
        const profile = database.getProfileByIdForUser(profileId, current.id);
        if (!profile) return sendJson(res, 404, { error: 'Resource not found.' }, {}, config);
        return sendJson(res, 200, { profile: apiProfile(profile) }, {}, config);
      }
      if (pathname === '/api/onboarding') {
        const profile = database.getProfileForUser(current.id);
        return sendJson(res, 200, { onboarding: { step: profile.onboarding_step, completed: Boolean(profile.onboarding_completed), completionState: completionState(profile) } }, {}, config);
      }
      if (pathname === '/api/evidence') {
        const filters = {
          query: url.searchParams.get('q') || '',
          status: EVIDENCE_STATUSES.includes(url.searchParams.get('status')) ? url.searchParams.get('status') : '',
          evidenceType: EVIDENCE_TYPES.includes(url.searchParams.get('type')) ? url.searchParams.get('type') : '',
          skillId: url.searchParams.get('skillId') || '',
          projectId: url.searchParams.get('projectId') || '',
          experienceId: url.searchParams.get('experienceId') || '',
          educationId: url.searchParams.get('educationId') || '',
        };
        return sendJson(res, 200, { evidence: database.listEvidenceForUser(current.id, filters).map(apiEvidence) }, {}, config);
      }
      if (pathname === '/api/applications') return sendJson(res, 200, { applications: database.listApplicationsForUser(current.id).map(apiApplication) }, {}, config);
      const applicationApiMatch = pathname.match(/^\/api\/applications\/([^/]+)$/);
      if (applicationApiMatch) {
        const application = database.getApplicationForUser(decodeURIComponent(applicationApiMatch[1]), current.id);
        if (!application) return sendJson(res, 404, { error: 'Resource not found.' }, {}, config);
        return sendJson(res, 200, { application: apiApplication(currentApplicationView(application, applicationContextForUser(current.id, application.opportunityId))) }, {}, config);
      }
      const roadmapApiMatch = pathname.match(/^\/api\/opportunities\/([^/]+)\/roadmap$/);
      if (roadmapApiMatch) {
        const opportunity = database.getOpportunityByIdForUser(decodeURIComponent(roadmapApiMatch[1]), current.id);
        if (!opportunity) return sendJson(res, 404, { error: 'Resource not found.' }, {}, config);
        return sendJson(res, 200, { roadmap: database.getRoadmapItemsForUser(opportunity.id, current.id).map(apiRoadmap) }, {}, config);
      }
      if (pathname === '/api/opportunities') return sendJson(res, 200, { opportunities: database.listOpportunitiesForUser(current.id).map((row) => ({ ...apiOpportunity(row), queue: database.opportunityAnalysisSummaryForUser(row.id, current.id) })) }, {}, config);
      const opportunityApiId = entityIdFromPath(pathname, 'opportunities');
      if (opportunityApiId) {
        const record = database.getOpportunityByIdForUser(opportunityApiId, current.id);
        if (!record) return sendJson(res, 404, { error: 'Resource not found.' }, {}, config);
        return sendJson(res, 200, { opportunity: apiOpportunity(record) }, {}, config);
      }
      const requirementsMatch = pathname.match(/^\/api\/opportunities\/([^/]+)\/requirements$/);
      if (requirementsMatch) {
        const record = database.getOpportunityByIdForUser(decodeURIComponent(requirementsMatch[1]), current.id);
        if (!record) return sendJson(res, 404, { error: 'Resource not found.' }, {}, config);
        return sendJson(res, 200, { analyses: database.listJobRequirementsForUser(record.id, current.id).map(apiRequirements) }, {}, config);
      }
      const matchesMatch = pathname.match(/^\/api\/opportunities\/([^/]+)\/matches$/);
      if (matchesMatch) {
        const record = database.getOpportunityByIdForUser(decodeURIComponent(matchesMatch[1]), current.id);
        if (!record) return sendJson(res, 404, { error: 'Resource not found.' }, {}, config);
        return sendJson(res, 200, { matchRun: database.getLatestMatchRunForUser(record.id, current.id) }, {}, config);
      }
      const scoreMatch = pathname.match(/^\/api\/opportunities\/([^/]+)\/score$/);
      if (scoreMatch) {
        const record = database.getOpportunityByIdForUser(decodeURIComponent(scoreMatch[1]), current.id);
        if (!record) return sendJson(res, 404, { error: 'Resource not found.' }, {}, config);
        return sendJson(res, 200, { score: database.getLatestScoreForUser(record.id, current.id) }, {}, config);
      }
      const gapsMatch = pathname.match(/^\/api\/opportunities\/([^/]+)\/gaps$/);
      if (gapsMatch) {
        const record = database.getOpportunityByIdForUser(decodeURIComponent(gapsMatch[1]), current.id);
        if (!record) return sendJson(res, 404, { error: 'Resource not found.' }, {}, config);
        const latestMatch = database.getLatestMatchRunForUser(record.id, current.id);
        const gapRun = latestMatch ? database.getGapRunForMatchRunForUser(latestMatch.id, current.id) : null;
        return sendJson(res, 200, { gapRun, gaps: gapRun ? database.getGapsForMatchRunForUser(gapRun.matchRunId, current.id) : null }, {}, config);
      }
      const reportMatch = pathname.match(/^\/api\/opportunities\/([^/]+)\/report$/);
      if (reportMatch) {
        const record = database.getOpportunityByIdForUser(decodeURIComponent(reportMatch[1]), current.id);
        if (!record) return sendJson(res, 404, { error: 'Resource not found.' }, {}, config);
        const report = database.getOpportunityReportForUser(record.id, current.id);
        const freshness = getReportFreshness({ database, userId: current.id, opportunity: opportunityView(record), reportRecord: report });
        return sendJson(res, 200, { report, freshness, companySignals: freshness.isStale ? null : database.getCompanySignalsForUser(record.id, current.id), relevance: freshness.isStale ? null : database.getProjectRelevanceForUser(record.id, current.id), roadmap: freshness.isStale ? [] : database.getRoadmapItemsForUser(record.id, current.id), application: database.getApplicationForOpportunityForUser(record.id, current.id) }, {}, config);
      }
      const evidenceApiId = entityIdFromPath(pathname, 'evidence');
      if (evidenceApiId) {
        const record = database.getEvidenceByIdForUser(evidenceApiId, current.id);
        if (!record) return sendJson(res, 404, { error: 'Resource not found.' }, {}, config);
        return sendJson(res, 200, { evidence: apiEvidence(record) }, {}, config);
      }
      const getCollections = {
        '/api/education': ['education', 'listEducationForUser', apiEducation],
        '/api/skills': ['skills', 'listSkillsForUser', apiSkill],
        '/api/projects': ['projects', 'listProjectsForUser', apiProject],
        '/api/experience': ['experience', 'listExperienceForUser', apiExperience],
      };
      if (getCollections[pathname]) {
        const [key, method, serialize] = getCollections[pathname];
        return sendJson(res, 200, { [key]: database[method](current.id).map(serialize) }, {}, config);
      }
      for (const [collection, configEntry] of [['education', ['education', 'getEducationByIdForUser', apiEducation]], ['skills', ['skills', 'getSkillByIdForUser', apiSkill]], ['projects', ['projects', 'getProjectByIdForUser', apiProject]], ['experience', ['experience', 'getExperienceByIdForUser', apiExperience]]]) {
        const id = entityIdFromPath(pathname, collection);
        if (id) {
          const record = database[configEntry[1]](id, current.id);
          if (!record) return sendJson(res, 404, { error: 'Resource not found.' }, {}, config);
          return sendJson(res, 200, { [configEntry[0].replace(/s$/, '')]: configEntry[2](record) }, {}, config);
        }
      }
      if (pathname === '/api/settings/account') return sendJson(res, 200, { user: { id: current.id, email: current.email } }, {}, config);
      if (pathname === '/api/settings/audit') return sendJson(res, 200, { events: database.listAuditEventsForUser(current.id) }, {}, config);
      return sendJson(res, 404, { error: 'Not found.' }, {}, config);
    }

    if (req.method === 'POST' && pathname === '/api/settings/password') {
      const current = requirePrincipal(req, res);
      if (!current) return;
      let body;
      try { body = await parseBody(req); } catch (error) { return formOrJsonError(req, res, 400, error.message, settingsPage({ principal: current, csrf: current.csrfToken, message: error.message })); }
      if (!csrfValid(req, body, current)) return rejectCsrf(res, req);
      const user = database.getUserWithPasswordById(current.id);
      const passwordError = validatePassword(body.newPassword);
      if (!verifyPassword(body.currentPassword || '', user.password_hash) || passwordError) return formOrJsonError(req, res, 400, 'Current password or new password is invalid.', settingsPage({ principal: current, csrf: current.csrfToken, message: 'Current password or new password is invalid.' }));
      database.updatePassword(current.id, hashPassword(body.newPassword));
      const session = createSession(current.id);
      database.createAuditEvent({ userId: current.id, action: 'auth.password_changed', metadata: {} });
      if (isJsonRequest(req)) return sendJson(res, 200, { message: 'Password changed successfully.' }, { 'Set-Cookie': authCookies(session.token, session.csrfToken) }, config);
      return redirect(res, '/settings?password=changed', config, { 'Set-Cookie': authCookies(session.token, session.csrfToken) });
    }

    if (req.method === 'GET' && (pathname === '/onboarding' || pathname.startsWith('/onboarding/'))) {
      const current = requirePrincipal(req, res);
      if (!current) return;
      const profile = database.getProfileForUser(current.id);
      if (pathname === '/onboarding') {
        if (profile.onboarding_completed) return redirect(res, '/dashboard', config);
        return redirect(res, `/onboarding/${profile.onboarding_step}`, config);
      }
      const step = pathname.slice('/onboarding/'.length);
      if (step === 'complete' || !ONBOARDING_STEPS.includes(step)) return redirect(res, profile.onboarding_completed ? '/dashboard' : '/onboarding', config);
      const csrf = csrfFor(req, res, current);
      return sendHtml(res, 200, onboardingPage({ principal: current, csrf, step, profile, education: database.listEducationForUser(current.id), skills: database.listSkillsForUser(current.id), projects: database.listProjectsForUser(current.id), experience: database.listExperienceForUser(current.id), message: url.searchParams.get('saved') === '1' ? 'Saved. You can continue when ready.' : '' }), {}, config);
    }

    if (req.method === 'GET' && pathname === '/discover') {
      const current = requirePrincipal(req, res);
      if (!current) return;
      const csrf = csrfFor(req, res, current);
      const saved = url.searchParams.get('saved');
      const message = saved === 'web' ? 'Web scan completed.' : saved === 'email' ? 'Email scan completed.' : saved === 'manual' ? 'Opportunity preserved and sent through analysis.' : '';
      return sendHtml(res, 200, discoverPage({ principal: current, csrf, profile: database.getProfileForUser(current.id), skills: database.listSkillsForUser(current.id), runs: database.listDiscoveryRunsForUser(current.id), connections: database.listMailboxConnectionsForUser(current.id), message }), {}, config);
    }

    if (req.method === 'GET' && (pathname === '/evidence' || pathname === '/evidence/new' || /^\/evidence\/[^/]+$/.test(pathname))) {
      const current = requirePrincipal(req, res);
      if (!current) return;
      const csrf = csrfFor(req, res, current);
      const optionData = evidenceOptions({
        skills: database.listSkillsForUser(current.id),
        projects: database.listProjectsForUser(current.id),
        experience: database.listExperienceForUser(current.id),
        education: database.listEducationForUser(current.id),
      });
      if (pathname === '/evidence/new') return sendHtml(res, 200, layout({
        title: 'Add evidence', active: 'evidence', principal: current, csrf,
        body: `<section class="content-card wide-card"><p class="eyebrow">EVIDENCE LOCKER</p><h1>Add evidence.</h1><p class="lead">Record a concrete source that can support a future claim. Capability context remains explicit and is never inferred from the source type.</p><p class="form-link"><a href="/evidence">Back to Evidence Locker</a></p>${evidenceForm({ csrf, options: optionData })}</section>`,
      }), {}, config);
      const detailMatch = pathname.match(/^\/evidence\/([^/]+)$/);
      if (detailMatch) {
        let recordId;
        try { recordId = decodeURIComponent(detailMatch[1]); } catch { recordId = ''; }
        const record = recordId ? database.getEvidenceByIdForUser(recordId, current.id) : null;
        if (!record) return sendHtml(res, 404, layout({ title: 'Evidence not found', active: 'evidence', principal: current, csrf, body: '<section class="content-card"><p class="eyebrow">EVIDENCE LOCKER</p><h1>Evidence not found.</h1><p class="error-state">That evidence record is unavailable.</p><p class="form-link"><a href="/evidence">Return to Evidence Locker</a></p></section>' }), {}, config);
        return sendHtml(res, 200, evidenceDetailPage({ principal: current, csrf, record: evidenceRecordWithLabels(record, optionData), options: optionData, message: url.searchParams.get('saved') === '1' ? 'Saved.' : '' }), {}, config);
      }
      const filters = {
        query: url.searchParams.get('q') || '',
        status: EVIDENCE_STATUSES.includes(url.searchParams.get('status')) ? url.searchParams.get('status') : '',
        evidenceType: EVIDENCE_TYPES.includes(url.searchParams.get('type')) ? url.searchParams.get('type') : '',
        skillId: url.searchParams.get('skillId') || '',
        projectId: url.searchParams.get('projectId') || '',
        experienceId: url.searchParams.get('experienceId') || '',
        educationId: url.searchParams.get('educationId') || '',
      };
      const records = database.listEvidenceForUser(current.id, filters).map((record) => evidenceRecordWithLabels(record, optionData));
      return sendHtml(res, 200, evidenceLockerPage({ principal: current, csrf, records, options: optionData, filters, message: url.searchParams.get('saved') === '1' ? 'Saved.' : url.searchParams.get('deleted') === '1' ? 'Evidence deleted.' : '' }), {}, config);
    }

    if (req.method === 'GET' && (pathname === '/opportunities' || pathname === '/opportunities/new' || /^\/opportunities\/[^/]+$/.test(pathname))) {
      const current = requirePrincipal(req, res);
      if (!current) return;
      const csrf = csrfFor(req, res, current);
      if (pathname === '/opportunities/new') return sendHtml(res, 200, layout({
        title: 'Add opportunity', active: 'opportunities', principal: current, csrf,
        body: `<section class="content-card wide-card"><p class="eyebrow">DISCOVER · MANUAL</p><h1>Analyze an opportunity.</h1><p class="lead">The original source is preserved, then sent through requirements analysis, evidence matching, deterministic scoring, gap analysis, and report generation.</p><p class="form-link"><a href="/opportunities">Back to opportunities</a></p>${opportunityForm({ csrf, action: '/api/discover/manual', submit: 'Analyze opportunity' })}</section>`,
      }), {}, config);
      const detailMatch = pathname.match(/^\/opportunities\/([^/]+)$/);
      if (detailMatch) {
        let recordId;
        try { recordId = decodeURIComponent(detailMatch[1]); } catch { recordId = ''; }
        const opportunity = recordId ? opportunityView(database.getOpportunityByIdForUser(recordId, current.id)) : null;
        if (!opportunity) return sendHtml(res, 404, layout({ title: 'Opportunity not found', active: 'opportunities', principal: current, csrf, body: '<section class="content-card"><p class="eyebrow">OPPORTUNITIES</p><h1>Opportunity not found.</h1><p class="error-state">That opportunity is unavailable.</p><p class="form-link"><a href="/opportunities">Return to opportunities</a></p></section>' }), {}, config);
        const requirements = database.getLatestJobRequirementsForUser(opportunity.id, current.id, opportunity.contentHash);
        const matchRun = requirements ? database.getLatestMatchRunForUser(opportunity.id, current.id) : null;
        const score = matchRun && requirements && matchRun.jobRequirementsId === requirements.id ? database.getLatestScoreForUser(opportunity.id, current.id) : null;
        const gapRun = score && matchRun && score.matchRunId === matchRun.id ? database.getGapRunForMatchRunForUser(matchRun.id, current.id) : null;
        const gaps = gapRun ? database.getGapsForMatchRunForUser(matchRun.id, current.id) : null;
        const report = database.getOpportunityReportForUser(opportunity.id, current.id);
        const companySignals = database.getCompanySignalsForUser(opportunity.id, current.id);
        const relevance = database.getProjectRelevanceForUser(opportunity.id, current.id);
        const roadmap = database.getRoadmapItemsForUser(opportunity.id, current.id);
        const freshness = getReportFreshness({ database, userId: current.id, opportunity, reportRecord: report });
        if (report) report.freshness = freshness;
        if (freshness.isStale) roadmap.stale = true;
        if (gaps) gaps.roadmap = roadmap;
        const evidence = database.listEvidenceForUser(current.id);
        const application = database.getApplicationForOpportunityForUser(opportunity.id, current.id);
        const savedMessages = { analysis: 'Requirements analyzed.', match: 'Evidence matched.', score: 'Score calculated.', gaps: 'Gaps analyzed.', duplicate: 'Existing opportunity reused and provenance added.', manual: 'Opportunity preserved and sent through analysis.' };
        return sendHtml(res, 200, opportunityReportPage({ principal: current, csrf, opportunity, requirements, matchRun: matchRun && requirements && matchRun.jobRequirementsId === requirements.id ? matchRun : null, score, gapRun, gaps, report, companySignals, relevance, roadmap, evidence, application, message: savedMessages[url.searchParams.get('saved')] || '' }), {}, config);
      }
      const opportunities = database.listOpportunitiesForUser(current.id).map((row) => {
        const item = opportunityView(row);
        return { ...item, queue: database.opportunityAnalysisSummaryForUser(item.id, current.id) };
      });
      return sendHtml(res, 200, opportunityQueuePage({ principal: current, csrf, opportunities, message: url.searchParams.get('saved') === '1' ? 'Opportunity saved.' : '' }), {}, config);
    }

    if (req.method === 'GET' && pathname === '/career-profile') {
      const current = requirePrincipal(req, res);
      if (!current) return;
      const csrf = csrfFor(req, res, current);
      return sendHtml(res, 200, profilePage({ principal: current, csrf, profile: database.getProfileForUser(current.id), education: database.listEducationForUser(current.id), skills: database.listSkillsForUser(current.id), projects: database.listProjectsForUser(current.id), experience: database.listExperienceForUser(current.id), message: url.searchParams.get('saved') === '1' ? 'Saved.' : '' }), {}, config);
    }
    if (req.method === 'GET' && pathname === '/discovery') {
      const current = requirePrincipal(req, res);
      if (!current) return;
      return redirect(res, '/discover', config);
    }
    if (req.method === 'GET' && pathname === '/analysis') {
      if (!requirePrincipal(req, res)) return;
      return redirect(res, '/opportunities', config);
    }

    const applicationPageMatch = pathname.match(/^\/applications\/([^/]+)$/);
    if (req.method === 'GET' && applicationPageMatch) {
      const current = requirePrincipal(req, res);
      if (!current) return;
      const csrf = csrfFor(req, res, current);
      const application = database.getApplicationForUser(decodeURIComponent(applicationPageMatch[1]), current.id);
      if (!application) return sendHtml(res, 404, layout({ title: 'Application not found', active: 'applications', principal: current, csrf, body: '<section class="content-card"><p class="eyebrow">APPLICATION REVIEW</p><h1>Application not found.</h1><p class="error-state">That application draft is unavailable.</p><p class="form-link"><a href="/applications">Return to applications</a></p></section>' }), {}, config);
      const opportunity = opportunityView(database.getOpportunityByIdForUser(application.opportunityId, current.id));
      if (!opportunity) return sendHtml(res, 404, layout({ title: 'Opportunity not found', active: 'applications', principal: current, csrf, body: '<section class="content-card"><p class="eyebrow">APPLICATION REVIEW</p><h1>Opportunity not found.</h1><p class="error-state">The opportunity for this draft is unavailable.</p></section>' }), {}, config);
      const applicationContext = applicationContextForUser(current.id, application.opportunityId);
      const applicationState = applicationContext ? applicationFreshness(application, applicationContext) : { isStale: true, reasons: ['MISSING_CONTEXT'] };
      return sendHtml(res, 200, applicationPage({ principal: current, csrf, application: currentApplicationView(application, applicationContext), opportunity, error: applicationState.isStale ? `This draft is stale and must be saved again before human review. ${applicationState.reasons.join(', ')}` : '', message: url.searchParams.get('saved') === '1' ? 'Draft saved and claims re-checked.' : url.searchParams.get('saved') === 'review' ? 'Marked ready for human review.' : '' }), {}, config);
    }

    const pageRoutes = {
      '/dashboard': ['Overview', 'dashboard', 'The command center for your next evidence-backed career action.', 'The Overview shell is protected and ready for the Career Commander workflow.'],
      '/profile': ['Profile', 'profile', 'Maintain the candidate context used by discovery and opportunity reports.', 'Profile data is scoped to the authenticated principal.'],
      '/discovery': ['Discover', 'discover', 'Find and import opportunities into your private workspace.', 'Discovery runs are scoped to the authenticated principal.'],
      '/applications': ['Applications', 'applications', 'Review application work only after a human chooses to prepare it.', 'No automatic submission is allowed.'],
      '/settings': ['Settings', 'settings', 'Control account security and access to your workspace.', 'Account settings are active.'],
    };
    if (req.method === 'GET' && pageRoutes[pathname]) {
      const current = requirePrincipal(req, res);
      if (!current) return;
      const csrf = csrfFor(req, res, current);
      if (pathname === '/dashboard') {
        const profile = database.getProfileForUser(current.id);
        const dashboard = dashboardDataForUser(database, current.id);
        return sendHtml(res, 200, dashboardPage({ principal: current, csrf, profile, skills: database.listSkillsForUser(current.id), projects: database.listProjectsForUser(current.id), evidence: dashboard.evidence, dashboard }), {}, config);
      }
      if (pathname === '/profile') return sendHtml(res, 200, profilePage({ principal: current, csrf, profile: database.getProfileForUser(current.id), education: database.listEducationForUser(current.id), skills: database.listSkillsForUser(current.id), projects: database.listProjectsForUser(current.id), experience: database.listExperienceForUser(current.id), message: url.searchParams.get('saved') === '1' ? 'Saved.' : '' }), {}, config);
      if (pathname === '/discovery') return redirect(res, '/discover', config);
      if (pathname === '/applications') return sendHtml(res, 200, applicationsPage({ principal: current, csrf, applications: database.listApplicationsForUser(current.id), opportunities: database.listOpportunitiesForUser(current.id).map(opportunityView) }), {}, config);
      if (pathname === '/settings') return sendHtml(res, 200, settingsPage({ principal: current, csrf, message: url.searchParams.get('password') === 'changed' ? 'Password changed. Other sessions were signed out.' : '' }), {}, config);
      const [title, active, description, nextAction] = pageRoutes[pathname];
      return sendHtml(res, 200, protectedPage({ title, active, principal: current, csrf, description, nextAction }), {}, config);
    }

    return send(res, 404, 'Not found', { ...securityHeaders(config), 'Content-Type': 'text/plain; charset=utf-8' });
  }

  const server = http.createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch((error) => {
      if (res.headersSent) return res.destroy();
      if (error.statusCode) return sendJson(res, error.statusCode, { error: error.message }, {}, config);
      console.error(error);
      return sendJson(res, 500, { error: 'Internal server error.' }, {}, config);
    });
  });
  server.database = database;
  return server;
}

module.exports = { createApp };
