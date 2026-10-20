# OrangeHRM public demo — unauthenticated read-only QA investigation

Generated 2026-10-20T14:31:38.925Z · Environment: **staging** · Mission `ui-opensource-demo-orangehrmlive-com-20261020-142705`

**Objective:** Inspect the login page, form validation, navigation, visible UI behavior, and publicly accessible API behavior. Do not attempt login bypass or modify data.

**Scope:** https://opensource-demo.orangehrmlive.com/ (hosts: opensource-demo.orangehrmlive.com) · **Authorization:** I authorize testing of the official OrangeHRM public demo within the configured scope. — Self-authorized — public demo testing limited to permitted, non-invasive checks.

## Executive summary

Read-only investigation of the OrangeHRM OS 5.9 public demo login, password-reset entry, navigation, and unauthenticated API surface (Chromium only). Client-side validation, redirects for protected routes, 401 on REST API v2 without a session, CORS handling, mobile layout and back/forward navigation behaved correctly. 6 findings, all confirmed by reproduction (2/2 attempts): 3 medium (Forgot-password control not keyboard reachable; login page breaks into raw i18n keys with an uncaught AxiosError when the i18n API fails; missing accessible names/lang/aria-invalid) and 3 low (no clickjacking protection plus a weak CSP; nginx version disclosure and missing HSTS on API responses; misleading 'Session expired' 401 message and an empty HTML 404 for unknown API routes). Of 18 scenarios: 9 passed, 1 partial, 5 failed, 3 blocked.

## Overall risk

No critical or high-severity defects were observed in the unauthenticated surface. The main risks are accessibility (keyboard and screen-reader users are blocked from password recovery and get poor form semantics) and resilience (an i18n outage leaves the login page unreadable). The security header findings are confirmed as missing headers only; exploitability was not demonstrated. All authenticated functionality is untested, so overall product risk remains largely unknown.

## Findings at a glance

| Severity | critical | high | medium | low | info |
|---|---|---|---|---|---|
| Count | 0 | 0 | 3 | 3 | 0 |

Status: Confirmed 6 · Potential 0 · Not Reproduced 0 · Blocked 0

| ID | Sev | Pri | Status | Category | Title | Resource |
|---|---|---|---|---|---|---|
| QA-001 | medium | P2 | Confirmed | accessibility | "Forgot your password?" control is not keyboard-focusable on the login page | `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login` |
| QA-002 | medium | P3 | Confirmed | resilience | Login page shows raw translation keys and throws uncaught AxiosError when i18n messages API fails | `GET /web/index.php/core/i18n/messages` |
| QA-006 | medium | P3 | Confirmed | accessibility | Login/reset forms lack accessible names, page lang and named icon links; validation errors not exposed programmatically | `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login` |
| QA-003 | low | P3 | Confirmed (verified) | security | HTML pages lack clickjacking protection (no X-Frame-Options, no CSP frame-ancestors); CSP allows unsafe-inline/unsafe-eval | `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login` |
| QA-004 | low | P4 | Confirmed (verified) | security | Server header discloses nginx/1.18.0 (Ubuntu) and HSTS is missing on REST API / error responses | `GET /web/index.php/api/v2/pim/employees` |
| QA-005 | low | P4 | Confirmed | api | REST API returns misleading 'Session expired' to never-authenticated clients; unknown API routes return empty HTML 404 | `GET /web/index.php/api/v2/pim/employees` |

## Coverage (measured against recorded denominators)

- **scenarioExecution**: 18/18 (100%) — Scenarios with a recorded result (passed/failed/partial/blocked) ÷ scenarios planned in this mission.
- **scenarioCompletion**: 14/18 (77.8%) — Scenarios with a conclusive pass/fail ÷ scenarios planned (blocked and partial excluded).
- **requirementsCoverage**: n/a (no denominator recorded) — Recorded requirements with ≥1 attempted scenario ÷ requirements recorded from stated sources.
- **requirementsPlanned**: n/a (no denominator recorded) — Recorded requirements with ≥1 planned scenario ÷ requirements recorded.
- **requirementsWithFailures**: n/a (no denominator recorded) — Requirements with ≥1 failed scenario ÷ requirements recorded.
- **endpointCoverage**: 4/10 (40%) — Registered endpoints (from docs/network/supplied) that received ≥1 investigator request ÷ endpoints registered. Says nothing about depth.

See `coverage-matrix.md` for the per-category matrix.

## Blocked and untested

- BLOCKED S3 Valid login reaches dashboard: Login submits POST /auth/validate; mission is read-only (allowStateChanging=false) and no credentials were provided as secrets.
- BLOCKED S4 Invalid credentials show error message (server submission): Requires POST submission to /auth/validate, not permitted in read-only scope.
- BLOCKED S13 Submit reset request for a username: Reset request is a POST that may trigger emails/state change; not permitted in read-only scope.

## Limitations

- Browsers not installed for this Playwright version: firefox, webkit. Cross-browser checks on them are blocked.
- Mission is read-only (GET/HEAD/OPTIONS); create/update/delete behaviour was not exercised through the API tool.
- No requirements were recorded; expectations rely on stated conventions, so requirements coverage cannot be computed.
- Security checks were limited to safe, non-destructive observations within the authorised scope. The absence of findings in an area is not evidence that it is secure.
- No direct database or service-layer access was available unless stated; data-integrity conclusions are based on UI/API observations only.
- Request budget used: 16/400; browser actions: 69/1500.
- Read-only scope: login (POST /auth/validate) and reset-password submission (POST) were not exercised, so authentication, invalid-credential messaging, lockout/rate limiting and all post-login modules are untested.
- No credentials were supplied as secrets; authenticated API authorization (IDOR, role checks) was not tested.
- Chromium only; Firefox and WebKit were unavailable.
- No requirements or API documentation were found on in-scope pages; expectations are based on cited conventions (WCAG, OWASP, RFC) rather than product requirements.
- API endpoints beyond the observed i18n call were probed by OrangeHRM 5 path convention, not from a published spec, so the endpoint denominator is incomplete.
- A keyboard Enter-activation check crashed the investigator connection; the mission was resumed and keyboard reachability was concluded from focus-order capture and DOM verification instead.
- Accessibility checks are heuristic; no screen-reader or colour-contrast audit was performed.
- The demo is shared and publicly reset, so behaviour may differ from production deployments.

## Recommended next investigations (highest risk first)

- With an approved test environment that allows POST, test login with valid and invalid credentials, lockout/rate limiting, session fixation and logout invalidation.
- Use authenticated sessions per role (Admin/ESS) to test REST API v2 authorization, pagination and input validation.
- Run the i18n fault injection with timeout and abort modes, and on the reset and dashboard pages.
- Do a full screen-reader and axe audit, including focus indicators on buttons (the heuristic flagged them) and colour contrast.
- Run a cross-browser pass in Firefox and WebKit.
- Build a safe local framing proof of concept to judge clickjacking impact on authenticated pages.
- [risk 75] S3 Valid login reaches dashboard — blocked (Login submits POST /auth/validate; mission is read-only (allowStateChanging=false) and no credentials were provided as secrets.)
- [risk 75] S4 Invalid credentials show error message (server submission) — blocked (Requires POST submission to /auth/validate, not permitted in read-only scope.)
- [risk 50] S7 REST API v2 endpoints return 401 JSON without session — partial
- [risk 48] S13 Submit reset request for a username — blocked (Reset request is a POST that may trigger emails/state change; not permitted in read-only scope.)
- Endpoint GET /web/index.php/core/i18n/messages (network) never exercised
- Endpoint POST /web/index.php/auth/validate (observed (login form action)) never exercised
- Endpoint POST /web/index.php/auth/requestResetPassword (observed (reset form action)) never exercised
- Endpoint GET /web/index.php/dashboard/index (observed (redirect target probe)) never exercised
- Endpoint GET /web/index.php/auth/logout (probe) never exercised

## Finding details

### QA-001 — "Forgot your password?" control is not keyboard-focusable on the login page

- **Category:** accessibility · **Severity:** medium (Keyboard-only and assistive-tech users cannot reach the account-recovery path; a mouse workaround is required.) · **Priority:** P2 (Blocks a core public flow for a user group; simple fix (use <a>/<button>).)
- **Status:** Confirmed · **Resource:** `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login` · **Environment:** staging · **Recorded:** 2026-10-20T14:29:54.390Z
- **Steps:**
  1. Open https://opensource-demo.orangehrmlive.com/web/index.php/auth/login
  2. Press Tab repeatedly from the top of the page
  3. Observe focus order: Username/Password -> Login -> 4 social icon links -> OrangeHRM, Inc -> body; 'Forgot your password?' never receives focus
  4. Note the text is also not exposed as a link/button (absent from the page's link and button lists), yet a mouse click navigates to /auth/requestPasswordResetCode
- **Expected:** The recovery control is a focusable link or button reachable by Tab and activatable by Enter. _(source: convention: WCAG 2.1 SC 2.1.1 Keyboard and 4.1.2 Name, Role, Value)_
- **Actual:** Element is clickable by mouse only (EV-004 shows mouse navigation works) but is absent from tab order and from links/buttons (EV-001, EV-003).
- **Impact / scope:** Keyboard/screen-reader users cannot start password recovery. / Login page; Chromium 1280x800
- **Suggested follow-up:** Confirm with a screen reader (NVDA/VoiceOver) and in Firefox/WebKit.
- **Evidence:** [EV-001](evidence/EV-001-inspect-web-index-php-auth-login.json), [EV-003](evidence/EV-003-inspect-web-index-php-auth-login.json), [EV-004](evidence/EV-004-open-forgot-password-via-mouse.png), [EV-032](evidence/EV-032-verify-qa-001-attempt-1.png), [EV-033](evidence/EV-033-verify-qa-001-attempt-2.png)
- **Verification 2026-10-20T14:30:55.822Z:** browser, reproduced 2/2 → Confirmed. Reproduced 2/2.

### QA-002 — Login page shows raw translation keys and throws uncaught AxiosError when i18n messages API fails

- **Category:** resilience · **Severity:** medium (Entire login UI becomes unreadable keys (auth.login, general.username) with no user-facing error or retry; affects all users if the i18n endpoint degrades.) · **Priority:** P3 (Requires backend failure to trigger, but impact on that occasion is total for the entry page.)
- **Status:** Confirmed · **Resource:** `GET /web/index.php/core/i18n/messages` · **Environment:** staging · **Recorded:** 2026-10-20T14:30:00.822Z
- **Preconditions:** GET /web/index.php/core/i18n/messages returns HTTP 500 (simulated in investigator browser only)
- **Steps:**
  1. Simulate 500 for /core/i18n/messages in the browser session
  2. Open /web/index.php/auth/login
  3. Observe page text and console
- **Expected:** Fallback to default (English) strings or a clear error with retry; no unhandled exception. _(source: convention: graceful degradation of non-critical dependency / error handling for failed XHR)_
- **Actual:** Visible text: 'auth.login ... general.username general.password auth.login auth.forgot_password?'. Console: pageerror 'AxiosError: fe' (uncaught).
- **Impact / scope:** Users see a broken, unlabeled login screen during i18n outages. / Login page (likely all Vue pages that load i18n)
- **Suggested follow-up:** Check other failure modes (timeout/abort) and reset-password page.
- **Evidence:** [EV-020](evidence/EV-020-login-page-with-i18n-api-returning-500.png), [EV-022](evidence/EV-022-verify-qa-002-attempt-1.png), [EV-023](evidence/EV-023-verify-qa-002-attempt-2.png)
- **Verification 2026-10-20T14:30:32.960Z:** browser, reproduced 2/2 → Confirmed. Reproduced 2/2.

### QA-006 — Login/reset forms lack accessible names, page lang and named icon links; validation errors not exposed programmatically

- **Category:** accessibility · **Severity:** medium (Screen readers announce unnamed fields/links; 'Required' errors are visual only.) · **Priority:** P3 (Broad but individually small fixes; no functional block for sighted users.)
- **Status:** Confirmed · **Resource:** `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login` · **Environment:** staging · **Recorded:** 2026-10-20T14:30:29.125Z
- **Possible duplicate of:** QA-001 (similarity 0.57)
- **Steps:**
  1. Open /auth/login and inspect
  2. Username/password inputs rely on placeholder only
  3. <html> has no lang; no <h1>; 4 social icon links have no accessible name
  4. Click Login with empty fields: 'Required' shown but no field reports invalid state
- **Expected:** Inputs programmatically labelled, html lang set, icon links have aria-label, invalid fields set aria-invalid/aria-describedby. _(source: convention: WCAG 2.1 SC 1.3.1, 2.4.4, 3.1.1, 3.3.1, 4.1.2)_
- **Actual:** As described; same pattern on reset page (EV-005).
- **Impact / scope:** Assistive-technology users get poor or missing announcements on the entry pages. / Login and Reset Password pages
- **Suggested follow-up:** Full axe + screen-reader audit; check contrast and button focus indicators.
- **Evidence:** [EV-002](evidence/EV-002-submit-empty-login-form.png), [EV-005](evidence/EV-005-inspect-web-index-php-auth-requestpasswo.json), [EV-017](evidence/EV-017-username-only-rapid-clicks.png), [EV-019](evidence/EV-019-inspect-web-index-php-auth-login.json), [EV-030](evidence/EV-030-verify-qa-006-attempt-1.png), [EV-031](evidence/EV-031-verify-qa-006-attempt-2.png)
- **Verification 2026-10-20T14:30:48.265Z:** browser, reproduced 2/2 → Confirmed. Reproduced 2/2.

### QA-003 — HTML pages lack clickjacking protection (no X-Frame-Options, no CSP frame-ancestors); CSP allows unsafe-inline/unsafe-eval

- **Category:** security · **Severity:** low (Header-level indicator only; exploitability (e.g., framing the login page) not demonstrated and framing an unauthenticated login page has limited impact.) · **Priority:** P3 (Defence-in-depth hardening; cheap to add.)
- **Status:** Confirmed · security confidence: verified · **Resource:** `https://opensource-demo.orangehrmlive.com/web/index.php/auth/login` · **Environment:** staging · **Recorded:** 2026-10-20T14:30:12.630Z
- **Steps:**
  1. GET /web/index.php/auth/login
  2. Inspect response headers
- **Expected:** X-Frame-Options: DENY/SAMEORIGIN or CSP frame-ancestors 'self'; CSP without unsafe-eval. _(source: convention: OWASP Secure Headers Project / OWASP Clickjacking Defense Cheat Sheet)_
- **Actual:** No X-Frame-Options; CSP 'default-src blob: 'self' ... 'unsafe-inline' 'unsafe-eval'' with no frame-ancestors. Also no Referrer-Policy.
- **Impact / scope:** Pages could be framed by third-party sites (clickjacking); CSP gives weak XSS mitigation. / HTML responses on opensource-demo host
- **Suggested follow-up:** Safe framing PoC on a local page to confirm browser renders the frame; review authenticated pages.
- **Evidence:** [EV-009](evidence/EV-009-login-page-headers.json), [EV-010](evidence/EV-010-dashboard-unauthenticated.json), [EV-024](evidence/EV-024-verify-qa-003-attempt-1.json), [EV-025](evidence/EV-025-verify-qa-003-attempt-2.json)
- **Verification 2026-10-20T14:30:44.978Z:** api, reproduced 2/2 → Confirmed. Reproduced 2/2.

### QA-004 — Server header discloses nginx/1.18.0 (Ubuntu) and HSTS is missing on REST API / error responses

- **Category:** security · **Severity:** low (Information disclosure and inconsistent transport hardening; no direct exploit shown.) · **Priority:** P4 (Hardening item.)
- **Status:** Confirmed · security confidence: verified · **Resource:** `GET /web/index.php/api/v2/pim/employees` · **Environment:** staging · **Recorded:** 2026-10-20T14:30:17.126Z
- **Steps:**
  1. GET /web/index.php/api/v2/pim/employees without session
  2. GET /web/index.php/api/v2/does-not-exist
  3. Compare headers with /auth/login
- **Expected:** Server version suppressed; Strict-Transport-Security on all HTTPS responses. _(source: convention: OWASP Secure Headers Project / RFC 6797)_
- **Actual:** Server: nginx/1.18.0 (Ubuntu) on all responses; Strict-Transport-Security present on HTML routes but absent on /api/v2/* and 404 responses.
- **Impact / scope:** Eases fingerprinting; inconsistent HSTS coverage. / All responses (version); API and 404 responses (HSTS)
- **Suggested follow-up:** Set server_tokens off; add HSTS at nginx level for every location.
- **Evidence:** [EV-011](evidence/EV-011-pim-employees-api-unauthenticated.json), [EV-014](evidence/EV-014-unknown-api-route.json), [EV-009](evidence/EV-009-login-page-headers.json), [EV-026](evidence/EV-026-verify-qa-004-attempt-1.json), [EV-027](evidence/EV-027-verify-qa-004-attempt-2.json)
- **Verification 2026-10-20T14:30:46.020Z:** api, reproduced 2/2 → Confirmed. Reproduced 2/2.

### QA-005 — REST API returns misleading 'Session expired' to never-authenticated clients; unknown API routes return empty HTML 404

- **Category:** api · **Severity:** low (Contract/consistency issue affecting API consumers' error handling; access control itself works (401).) · **Priority:** P4 (Cosmetic for UI, minor for integrators.)
- **Status:** Confirmed · **Resource:** `GET /web/index.php/api/v2/pim/employees` · **Environment:** staging · **Recorded:** 2026-10-20T14:30:21.993Z
- **Possible duplicate of:** QA-004 (similarity 0.61)
- **Steps:**
  1. Without any cookie, GET /web/index.php/api/v2/pim/employees
  2. GET /web/index.php/api/v2/does-not-exist
- **Expected:** 401 with a message such as 'Unauthorized'/'Authentication required'; unknown API routes return a JSON error body consistent with other API errors. _(source: convention: consistent REST error contract (RFC 9457 problem details style))_
- **Actual:** 401 {"error":{"status":401,"message":"Session expired"}} for a fresh client; 404 text/html with empty body for unknown /api/v2 path.
- **Impact / scope:** Clients cannot distinguish expiry from missing auth; inconsistent content types complicate error handling. / /web/index.php/api/v2/*
- **Suggested follow-up:** Check with authenticated session whether the message differs for real expiry.
- **Evidence:** [EV-011](evidence/EV-011-pim-employees-api-unauthenticated.json), [EV-012](evidence/EV-012-admin-users-api-unauthenticated.json), [EV-013](evidence/EV-013-dashboard-api-unauthenticated.json), [EV-014](evidence/EV-014-unknown-api-route.json), [EV-028](evidence/EV-028-verify-qa-005-attempt-1.json), [EV-029](evidence/EV-029-verify-qa-005-attempt-2.json)
- **Verification 2026-10-20T14:30:47.437Z:** api, reproduced 2/2 → Confirmed. Reproduced 2/2.
