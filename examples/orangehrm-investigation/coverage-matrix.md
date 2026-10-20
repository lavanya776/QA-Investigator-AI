# Coverage matrix

Coverage is measured only against the scenarios, requirements and endpoints recorded in this mission. It is not a claim of exhaustive testing.

| Category | Areas | Planned | Attempted | Passed | Failed | Partial | Blocked | Not tested | Defects | Evidence refs |
|---|---|---|---|---|---|---|---|---|---|---|
| functional | 2 | 8 | 8 | 5 | 0 | 0 | 3 | 0 | 0 | 5 |
| ui | 1 | 3 | 3 | 1 | 2 | 0 | 0 | 0 | 2 | 5 |
| api | 1 | 5 | 5 | 2 | 2 | 1 | 0 | 0 | 3 | 10 |
| security (not planned) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 |
| integration | 1 | 2 | 2 | 1 | 1 | 0 | 0 | 0 | 1 | 3 |
| compatibility (not planned) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| business-rules (not planned) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

## Metrics

- **scenarioExecution**: 18/18 (100%) — Scenarios with a recorded result (passed/failed/partial/blocked) ÷ scenarios planned in this mission.
- **scenarioCompletion**: 14/18 (77.8%) — Scenarios with a conclusive pass/fail ÷ scenarios planned (blocked and partial excluded).
- **requirementsCoverage**: n/a (no denominator recorded) — Recorded requirements with ≥1 attempted scenario ÷ requirements recorded from stated sources.
- **requirementsPlanned**: n/a (no denominator recorded) — Recorded requirements with ≥1 planned scenario ÷ requirements recorded.
- **requirementsWithFailures**: n/a (no denominator recorded) — Requirements with ≥1 failed scenario ÷ requirements recorded.
- **endpointCoverage**: 4/10 (40%) — Registered endpoints (from docs/network/supplied) that received ≥1 investigator request ÷ endpoints registered. Says nothing about depth.

## Areas by risk (impact × likelihood × exposure)

| Area | Category | Risk | Scenarios | Results | Rationale |
|---|---|---|---|---|---|
| A1 Login form & authentication flow | functional | 75 | 5 | passed:3 blocked:2 | Single entry point to the app; all users depend on it |
| A4 Login/reset UI, keyboard & accessibility | ui | 60 | 3 | failed:2 passed:1 | Every user sees these screens |
| A2 Unauthenticated access control (routes & REST API) | api | 50 | 5 | passed:2 partial:1 failed:2 | Public internet exposure of HR data APIs |
| A3 Password reset flow | functional | 48 | 3 | passed:2 blocked:1 | Account recovery path, public |
| A5 Frontend–backend integration (i18n, redirects, resilience) | integration | 36 | 2 | failed:1 passed:1 | UI depends on i18n API for all labels |

## Scenarios

| ID | Area | Technique | Status | Requirements | Findings | Evidence | Observation / reason |
|---|---|---|---|---|---|---|---|
| S1 | A1 | negative | passed |  |  | EV-002 | Both fields show 'Required'; no network request sent. |
| S2 | A1 | boundary | passed |  |  | EV-017 | Only password shows Required. |
| S3 | A1 | positive | blocked |  |  |  | Login submits POST /auth/validate; mission is read-only (allowStateChanging=false) and no credentials were provided as secrets. |
| S4 | A1 | negative | blocked |  |  |  | Requires POST submission to /auth/validate, not permitted in read-only scope. |
| S5 | A1 | exception | passed |  |  | EV-017 | 3 rapid clicks with invalid form: no submission requests. Rapid-click on a valid form not tested (would POST). |
| S6 | A2 | security | passed |  |  | EV-010 | 302 to /auth/login. |
| S7 | A2 | security | partial |  | QA-005 | EV-011, EV-012, EV-013 | 401 body says 'Session expired' for a client with no session. |
| S8 | A2 | negative | failed |  | QA-005 | EV-014 | Empty text/html 404 for unknown API path; no stack trace leaked. |
| S9 | A2 | security | failed |  | QA-003, QA-004 | EV-009, EV-011, EV-024, EV-026 | No X-Frame-Options/frame-ancestors; server version disclosed; HSTS missing on API. Session cookie is Secure; HttpOnly; SameSite=Lax (good). |
| S10 | A2 | security | passed |  |  | EV-008, EV-015 | No Access-Control-Allow-Origin for foreign Origin; OPTIONS 405. |
| S11 | A3 | positive | passed |  |  | EV-004, EV-006 | Mouse navigation works; keyboard reachability fails (see S14). |
| S12 | A3 | negative | passed |  |  | EV-018 |  |
| S13 | A3 | positive | blocked |  |  |  | Reset request is a POST that may trigger emails/state change; not permitted in read-only scope. |
| S14 | A4 | accessibility | failed |  | QA-001 | EV-001, EV-032 | 'Forgot your password?' absent from tab order and not an <a>/<button>. A keyboard Enter-activation attempt crashed the investigator connection; result based on focus-order capture and DOM verification |
| S15 | A4 | accessibility | failed |  | QA-006 | EV-001, EV-005, EV-030 | Inputs placeholder-only, html lang missing, no h1, icon links unnamed, Required errors not exposed via aria-invalid. |
| S16 | A4 | usability | passed |  |  | EV-019 | 375px: no horizontal overflow or overlap. |
| S17 | A5 | recovery | failed |  | QA-002 | EV-020, EV-022 | Raw i18n keys rendered and uncaught 'AxiosError: fe' when i18n API returns 500. |
| S18 | A5 | integration | passed |  |  | EV-021 |  |

## Requirements

| ID | Requirement | Source | Scenarios | Covered |
|---|---|---|---|---|

## Endpoints

| Endpoint | Source | Requests | Statuses seen |
|---|---|---|---|
| `GET /web/index.php/core/i18n/messages` | network | 0 |  |
| `GET /web/index.php/auth/login` | observed (login page route) | 2 | 200 |
| `POST /web/index.php/auth/validate` | observed (login form action) | 0 |  |
| `GET /web/index.php/auth/requestPasswordResetCode` | observed (navigation) | 2 | 200 |
| `POST /web/index.php/auth/requestResetPassword` | observed (reset form action) | 0 |  |
| `GET /web/index.php/dashboard/index` | observed (redirect target probe) | 0 |  |
| `GET /web/index.php/auth/logout` | probe | 0 |  |
| `GET /web/index.php/api/v2/pim/employees` | probe (OrangeHRM 5 REST API path convention) | 2 | 401 |
| `GET /web/index.php/api/v2/admin/users` | probe (OrangeHRM 5 REST API path convention) | 2 | 401 |
| `GET /web/index.php/api/v2/dashboard/employees/action-summary` | probe (OrangeHRM 5 REST API path convention) | 0 |  |