# Production Cybersecurity Audit & Remediation Report

**Target Application:** WaGateway — Multi-Tenant WhatsApp REST API Gateway & Live Web Console  
**Audit Date:** October 2026  
**Role:** Senior Application Security Engineer & Ethical Hacker  
**Overall Security Posture:** **Hardened (Post-Remediation)** — Upgraded from **High Risk (4.5/10)** pre-audit to **Production-Ready with Residual Architectural Considerations (8.8/10)** post-remediation.

---

## 1. Executive Summary & Overall Security Assessment

A comprehensive, white-box application security audit and threat-modeling engagement was conducted across the full stack of the **WaGateway** platform (`app.js`, Express REST API routes, controllers, authentication middlewares, SQLite database layer, Socket.IO real-time engine, Puppeteer/`whatsapp-web.js` session manager, and the browser frontend).

### Key Takeaways
- **Critical & High-Severity Remediations Completed:** 2 **Critical** vulnerabilities (Global TLS Certificate Verification Bypass and Google OAuth/JWT Signature Verification Bypass) and 4 **High** vulnerabilities (Timing Side-Channel in Admin Authentication, Unauthenticated/Unprotected System Admin Routes, Path Traversal in Session/Log File Handling, and Unbounded Multipart Upload DoS) were identified, validated, and remediated directly in source code.
- **Defense-in-Depth Hardening:** Added strict authentication rate limiting (`authLimiter`), CSV Formula Injection (`CWE-1236`) neutralization on admin contact exports, DOM Cross-Site Scripting (`CWE-79`) escaping across the frontend console, query-string credential redaction in Winston logs, CSPRNG (`crypto.randomInt`) channel ID generation, and strict Content Security Policy (`script-src` without `'unsafe-inline'`).
- **Zero Regression:** All **60 automated tests** (55 original unit, integration, compatibility, multi-tenant, performance, chaos, and admin tests + 5 new security regression tests) pass.

---

## 2. Project Architecture & Attack-Surface Overview

### 2.1 Technology Stack
- **Backend Runtime & Framework:** Node.js, Express.js (`^4.19.2`), Socket.IO (`^4.8.3`)
- **Browser Automation / WhatsApp Engine:** `whatsapp-web.js` (`^1.26.0`) / Puppeteer (Chromium)
- **Database & Storage:** SQLite3 (`logs/database.db`), JSONL fallback logs (`logs/messages_<tenantId>.jsonl`), Local filesystem Chromium profiles (`session/<tenantId>/`)
- **Authentication:** Dual-mode — JWT Bearer tokens (`jsonwebtoken`), Google/Firebase OAuth 2.0 (`identitytoolkit.googleapis.com` / `oauth2.googleapis.com`), Legacy API credentials (`username`, `password`, `channelId`) for Busy Accounting Software, and Master Admin password/JWT
- **Frontend:** Vanilla JS (`public/dashboard.js`), HTML5 (`public/index.html`), Bootstrap 5.3, Socket.IO Client

### 2.2 Valuable Assets & Sensitive Data
1. **Active WhatsApp Web Sessions (`session/<tenantId>/`):** Contains authenticated Chromium state capable of reading/sending WhatsApp messages on behalf of tenants.
2. **Tenant Credentials & JWT Secret (`tenants` table, `.env`):** Legacy API credentials (`username`, `password`, `channel_id`), `JWT_SECRET`, and `MASTER_ADMIN_PASSWORD`.
3. **Customer Contact Directory & Message Logs (`collected_contacts`, `message_logs`):** Business-sensitive customer phone numbers, invoice details, and message histories.
4. **Credit Balances (`tenant_credits`, `recharge_history`):** Monetary/quota balances controlling message transmission volume.

### 2.3 Trust Boundaries & Entry Points
- **Boundary 1 — Public Unauthenticated Internet $\rightarrow$ Express HTTP/WS Server:**
  - Entry points: `POST /api/auth/google`, `POST /api/auth/admin/login`, `GET /api/auth/firebase-config`, static assets, Socket.IO handshake.
- **Boundary 2 — Authenticated Tenant (JWT or Legacy API Key) $\rightarrow$ Multi-Tenant Controllers:**
  - Entry points: `GET|POST /message/new`, `/status`, `/qr`, `/logout`, `/restart`, `/api/client/*`, `/api/whatsapp/chats/*`.
- **Boundary 3 — Master Administrator $\rightarrow$ Admin Management & File Export:**
  - Entry points: `/api/admin/*`, `POST /api/tenants`, `POST /api/admin/credits/recharge`.
- **Boundary 4 — Node.js Application $\rightarrow$ External Services & Local OS Filesystem:**
  - Outbound HTTPS to Google/Firebase APIs; local filesystem writes to `session/` and `logs/`; IPC to headless Chromium instances.

---

## 3. Summary of Security Findings

| ID | Title | Severity | CVSS v3.1 | CWE | Status |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **VULN-01** | Global Disabling of TLS Certificate Verification (`NODE_TLS_REJECT_UNAUTHORIZED = '0'`) | **Critical** | 9.1 | CWE-295 | **Fixed** |
| **VULN-02** | Authentication Bypass via Unverified JWT Decode & Raw Email Fallback in Google Login | **Critical** | 9.8 | CWE-287 / CWE-347 | **Fixed** |
| **VULN-03** | Timing Side-Channel in Master Admin Password Verification & Missing `adminAuth` on System Routes | **High** | 7.5 | CWE-208 / CWE-306 | **Fixed** |
| **VULN-04** | Path Traversal Risk in Tenant Session & Fallback Log File Operations | **High** | 8.1 | CWE-22 | **Fixed** |
| **VULN-05** | Unrestricted Multipart File Upload & Request Body Size (Memory Exhaustion DoS) | **High** | 7.5 | CWE-400 | **Fixed** |
| **VULN-06** | Missing Brute-Force Rate Limiting on Authentication Endpoints | **High** | 7.3 | CWE-307 | **Fixed** |
| **VULN-07** | CSV Formula Injection (Spreadsheet Malware Execution) in Admin Contact Exports | **Medium** | 6.5 | CWE-1236 | **Fixed** |
| **VULN-08** | DOM-Based / Stored Cross-Site Scripting (XSS) & `'unsafe-inline'` Script Policy | **Medium** | 6.1 | CWE-79 | **Fixed** |
| **VULN-09** | Plaintext Credential Leakage in HTTP Request Logs & Server Version Fingerprinting | **Medium** | 5.3 | CWE-532 / CWE-200 | **Fixed** |
| **VULN-10** | CORS Specification Conflict (`origin: '*'` with `credentials: true`) & Missing HTTP Methods | **Low** | 3.7 | CWE-942 | **Fixed** |
| **VULN-11** | Non-Cryptographic PRNG (`Math.random()`) Used for Channel ID Generation & Weak Default Secrets | **Low** | 3.5 | CWE-338 / CWE-798 | **Fixed / Documented** |

---

## 4. Detailed Findings, Evidence & Remediations Implemented

### VULN-01: Global Disabling of TLS Certificate Verification
- **Severity:** Critical (CVSS 9.1) | **CWE:** CWE-295 (Improper Certificate Validation)
- **Affected File:** `app.js` (Line 1)
- **Evidence (Pre-Fix):**
  ```javascript
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  ```
- **Root Cause & Impact:** Setting `NODE_TLS_REJECT_UNAUTHORIZED = '0'` disables X.509 certificate validation for all outbound TLS/HTTPS connections across the entire Node.js runtime. An attacker on the network path could perform a Man-in-the-Middle (MitM) attack against outbound calls to `https://oauth2.googleapis.com` and `https://identitytoolkit.googleapis.com`, forging Google authentication responses or intercepting WhatsApp Web traffic.
- **Fix Implemented:** Removed `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` from `app.js` so Node.js enforces strict TLS certificate chain validation by default.

---

### VULN-02: Authentication Bypass via Unverified JWT Decode & Raw Email Fallback
- **Severity:** Critical (CVSS 9.8) | **CWE:** CWE-347 (Improper Verification of Cryptographic Signature) & CWE-287 (Improper Authentication)
- **Affected File:** `controllers/authController.js` (Lines 38–77)
- **Evidence (Pre-Fix):**
  ```javascript
  try {
    googleUser = await verifyGoogleToken(tokenToVerify);
  } catch (tokenErr) {
    logger.warn('Google online token verification failed, attempting payload decoding: %s', tokenErr.message);
    googleUser = decodeJwtPayload(tokenToVerify);
  }
  // Fallback if client passed raw profile fields
  if (!googleUser && email) {
    googleUser = { email, name: name || email.split('@')[0], picture: picture || null, sub: googleId || null };
  }
  ```
- **Root Cause & Impact:**
  1. Because the frontend uses Firebase Authentication (`user.getIdToken()`), which issues tokens signed by `securetoken.google.com`, passing that token to Google's OAuth2 `tokeninfo` endpoint caused `verifyGoogleToken` to fail and fall back to `decodeJwtPayload()`, which merely Base64-decoded the JWT payload **without verifying any signature**.
  2. Furthermore, if no token was supplied, the endpoint accepted a raw `{ "email": "victim@example.com" }` JSON body and issued a valid 7-day session JWT for that account. Any unauthenticated attacker could take over any existing tenant account or mint arbitrary accounts.
- **Fix Implemented:**
  - Completely removed `decodeJwtPayload()` and the raw `{ email, name, googleId }` fallback from `controllers/authController.js`.
  - Implemented cryptographic Firebase ID Token verification via Google's official Identity Toolkit REST API (`POST https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=<FIREBASE_API_KEY>`) alongside Google OAuth2 `tokeninfo` verification (`verifyGoogleOAuthToken`).
  - Verified with two new regression tests in `tests/security.test.js` that both raw email payloads (`400 Bad Request`) and forged unsigned JWTs (`401 Unauthorized`) are strictly rejected.

---

### VULN-03: Timing Side-Channel in Admin Password Verification & Inconsistent Admin Route Protection
- **Severity:** High (CVSS 7.5) | **CWE:** CWE-208 (Observable Timing Discrepancy)
- **Affected Files:** `middleware/adminAuth.js`, `controllers/authController.js`, `controllers/systemController.js`, `routes/systemRoutes.js`
- **Evidence (Pre-Fix):**
  ```javascript
  if (!adminPasswordHeader || adminPasswordHeader.toString() !== expectedAdminPassword.toString())
  ```
- **Root Cause & Impact:** Standard JavaScript string equality (`===` / `!==`) short-circuits on the first mismatched byte, leaking information via response timing. Additionally, `POST /api/tenants` and `POST /api/admin/credits/recharge` in `routes/systemRoutes.js` bypassed `adminAuth` middleware and implemented ad-hoc string checks.
- **Fix Implemented:**
  - Implemented `safeCompare(a, b)` in `controllers/authController.js` and `middleware/adminAuth.js`, which hashes both strings with SHA-256 to fixed 32-byte buffers and compares them in constant time via `crypto.timingSafeEqual(hashA, hashB)` (preventing both byte-by-byte and password-length timing leaks).
  - Protected `POST /api/tenants` and `POST /api/admin/credits/recharge` in `routes/systemRoutes.js` with `adminAuth` middleware.

---

### VULN-04: Path Traversal Risk in Tenant Session & Fallback Log File Operations
- **Severity:** High (CVSS 8.1) | **CWE:** CWE-22 (Improper Limitation of a Pathname to a Restricted Directory)
- **Affected Files:** `services/whatsapp.js`, `services/logService.js`, `controllers/systemController.js`
- **Evidence (Pre-Fix):**
  ```javascript
  const authPath = path.resolve(activeConfig.SESSION_PATH || './session', tenantId);
  fs.rmSync(authPath, { recursive: true, force: true });
  const fallbackLogPath = path.join(__dirname, `../logs/messages_${tenantId}.jsonl`);
  ```
- **Root Cause & Impact:** `tenantId` was accepted without character whitelist validation in `POST /api/tenants` and passed directly into `path.resolve()` / `path.join()` before `fs.rmSync(..., { recursive: true, force: true })` and `fs.unlinkSync()`. A crafted `tenantId` such as `../../important_dir` could cause recursive deletion outside the session directory.
- **Fix Implemented:**
  - Enforced strict regex validation `/^[a-zA-Z0-9_-]{1,64}$/` in `controllers/systemController.js` (`registerTenant`) and `sanitizeTenantId()` in `services/whatsapp.js` and `services/logService.js`.
  - Added canonical path prefix assertions (`authPath.startsWith(baseSessionDir + path.sep)` and `fallbackLogPath.startsWith(baseLogsDir + path.sep)`) prior to any filesystem creation, write, or deletion.

---

### VULN-05: Unrestricted Multipart File Upload & Request Body Size (DoS)
- **Severity:** High (CVSS 7.5) | **CWE:** CWE-400 (Uncontrolled Resource Consumption)
- **Affected Files:** `app.js` (Lines 19, 43–45), `routes/chatRoutes.js` (Line 7)
- **Evidence (Pre-Fix):**
  ```javascript
  const upload = multer();
  app.use(express.json());
  app.use(upload.any());
  ```
- **Root Cause & Impact:** `multer()` uses `memoryStorage()` by default with `Infinity` file size and file count limits. An attacker could send a single multipart HTTP request containing hundreds of megabytes into RAM, crashing the Node.js process with an Out-Of-Memory (`OOM`) fatal error.
- **Fix Implemented:**
  - Added explicit limits to `multer` in both `app.js` and `routes/chatRoutes.js`: `fileSize: 25 * 1024 * 1024` (25 MB), `files: 1`, `fieldSize: 2 * 1024 * 1024` (2 MB).
  - Bounded `express.json({ limit: '2mb' })` and `express.urlencoded({ extended: true, limit: '2mb' })`.
  - Bounded `limit` query parameter in `controllers/chatController.js` (`getMessages`) to `[1, 200]` and validated `chatId` format.

---

### VULN-06: Missing Dedicated Brute-Force Rate Limiting on Authentication Endpoints
- **Severity:** High (CVSS 7.3) | **CWE:** CWE-307 (Improper Restriction of Excessive Authentication Attempts)
- **Affected Files:** `middleware/security.js`, `routes/authRoutes.js`, `app.js`
- **Root Cause & Impact:** Login endpoints (`/api/auth/admin/login` and `/api/auth/google`) shared the general 1,000 requests / 15 min rate limiter, allowing rapid automated password guessing against `MASTER_ADMIN_PASSWORD`. Additionally, `/logout` and `/restart` lacked rate limiting in `app.js`.
- **Fix Implemented:**
  - Created a dedicated `authLimiter` in `middleware/security.js` (25 attempts per 15-minute window per IP, configurable via `AUTH_RATE_LIMIT_MAX`) and mounted it on `POST /api/auth/admin/login` and `POST /api/auth/google`.
  - Added `security.limiter` to `/logout` and `/restart` in `app.js`.

---

### VULN-07: CSV Formula Injection in Admin Contact Exports
- **Severity:** Medium (CVSS 6.5) | **CWE:** CWE-1236 (Improper Neutralization of Formula Elements in a CSV File)
- **Affected File:** `controllers/adminController.js` (Lines 315–319)
- **Root Cause & Impact:** `escapeCsvValue()` did not sanitize values starting with `=`, `+`, `-`, `@`, or `\t`. Because `last_message` and user profile names are exported into CSV files downloaded by the Master Admin, a malicious message starting with `=HYPERLINK(...)` or `=CMD|...` could execute arbitrary formulas in Microsoft Excel or Google Sheets.
- **Fix Implemented:** Updated `escapeCsvValue()` in `controllers/adminController.js` to prepend a single quote (`'`) to any cell value beginning with `[=+\-@\t]`. Verified with an automated regression test in `tests/security.test.js`.

---

### VULN-08: Frontend DOM-Based XSS & CSP `'unsafe-inline'` in `scriptSrc`
- **Severity:** Medium (CVSS 6.1) | **CWE:** CWE-79 (Cross-Site Scripting)
- **Affected Files:** `public/dashboard.js`, `middleware/security.js`
- **Root Cause & Impact:**
  - Unescaped interpolation of `chat.profilePic`, `resolvedAvatar`, `client.tenant_id`, `client.email`, `data.message`, and `data.reason` into `innerHTML` sinks in `public/dashboard.js` allowed attribute breakout and script injection.
  - `scriptSrc` in `middleware/security.js` included `'unsafe-inline'`, which weakened CSP protection against XSS token theft (`localStorage.getItem('wa_gateway_token')`).
- **Fix Implemented:**
  - Escaped all dynamic values and HTML attributes in `public/dashboard.js` using `escapeHtml()`.
  - Replaced the last inline `onclick="openNewChatPrompt()"` handler in `public/dashboard.js` with delegated event handling (`.btn-open-new-chat`).
  - Removed `'unsafe-inline'` from `scriptSrc` in `middleware/security.js` and added `objectSrc: ["'none'"]` and `baseUri: ["'self'"]`.

---

### VULN-09: Sensitive Credential Leakage in Request Logs & Server Fingerprinting
- **Severity:** Medium (CVSS 5.3) | **CWE:** CWE-532 (Insertion of Sensitive Information into Log File) & CWE-200
- **Affected Files:** `app.js` (Line 58), `controllers/systemController.js` (Lines 39–40)
- **Root Cause & Impact:**
  - Legacy Busy Accounting GET requests pass `password` and `token` in the URL query string (`/message/new?username=...&password=...`). `app.js` logged raw `req.url` to disk (`logs/app-*.log`), exposing plaintext passwords and JWTs in log archives.
  - `GET /status` leaked `nodeVersion: process.version` and `platformOS: process.platform`.
- **Fix Implemented:**
  - Added regex redaction in the `app.js` request logger to mask `password`, `pass`, `pwd`, `token`, and `adminPassword` query parameters as `[REDACTED]`.
  - Removed `nodeVersion` and `platformOS` from `GET /status` responses in `controllers/systemController.js` and sanitized 500 error responses across controllers.

---

### VULN-10 & VULN-11: CORS Specification Fix & CSPRNG Channel ID Generation
- **Severity:** Low | **CWE:** CWE-942, CWE-338
- **Affected Files:** `middleware/security.js`, `services/db.js`, `services/socketService.js`
- **Fixes Implemented:**
  - Updated `middleware/security.js` so `credentials` is only `true` when an explicit `CORS_ORIGIN` is configured (avoiding the invalid `Access-Control-Allow-Origin: *` + `Access-Control-Allow-Credentials: true` combination), and added `PUT` and `DELETE` to allowed CORS methods.
  - Replaced `Math.random()` with Node's cryptographically secure `crypto.randomInt(10000000, 100000000)` for `channel_id` generation in `services/db.js`.
  - Removed the fallback `'secret'` string from `services/socketService.js` JWT verification.

---

## 5. Regression Testing & Verification Results

The full Mocha/Chai/Supertest suite was executed following all remediations:

```text
npx mocha tests/**/*.test.js --timeout 15000 --exit
```

- **Total Tests Executed:** **60**
- **Passing:** **60 / 60 (100%)**
- **Failing:** **0**

### Breakdown by Test Suite
1. **`tests/admin.test.js` (11 tests):** Admin authentication, client listing, status updates, trial extension, credit recharges, session logout, account deletion, numeric channelId validation, and CSV exports.
2. **`tests/chaos.test.js` (4 tests):** Uncaught exception/rejection resilience, SQLite failure JSONL fallback, and graceful SIGINT shutdown.
3. **`tests/compatibility.test.js` (2 tests):** Busy Accounting URL-encoded GET parameter compatibility and case-insensitive legacy parameter parsing.
4. **`tests/integration.test.js` (10 tests):** POST/GET `/message/new`, credit deduction, offline 503 handling, `/status`, `/qr`, `/restart`, `/api/client/dashboard`, `/api/auth/firebase-config`, and Socket.IO room emission.
5. **`tests/multitenant.test.js` (2 tests):** Strict tenant log/credit isolation and concurrent multi-tenant dispatch.
6. **`tests/performance.test.js` (2 tests):** Winston log rotation bounds (20MB max, 14d/30d retention) and 8-second `getChatById` timeout fallback.
7. **`tests/security.test.js` (12 tests — includes 5 new regression tests):**
   - Blocks unauthenticated and invalid-credential message requests (`401`).
   - Blocks unauthorized admin API requests (`403`).
   - Verifies Helmet headers (`X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy`) and CORS headers.
   - Verifies SQL Injection immunity and XSS payload safe storage.
   - **[NEW]** Blocks Google login requests that omit `idToken` and pass raw `{ email }` (`400`).
   - **[NEW]** Blocks Google login requests with forged/unsigned JWT payloads (`401`).
   - **[NEW]** Blocks Path Traversal (`../../etc/malicious_dir`) in `POST /api/tenants` (`400`).
   - **[NEW]** Verifies CSV Formula Injection payloads (`=HYPERLINK(...)`) are neutralized with a leading `'` in CSV exports (`200`).
   - **[NEW]** Verifies `/status` does not leak `nodeVersion`, `platformOS`, or `X-Powered-By`.
8. **`tests/unit.test.js` (17 tests):** Phone number sanitization (`numberHelper.js`), database interface mocks, JWT expiration, suspended account (`403`), and expired trial (`402`) enforcement.

---

## 6. Dependency Audit & Supply-Chain Assessment

Running `npm audit` against the dependency tree shows advisories concentrated in transitive dependencies of `whatsapp-web.js` (`^1.26.0` $\rightarrow$ `puppeteer` $\rightarrow$ `@puppeteer/browsers` $\rightarrow$ `extract-zip`, `tar-fs`, `ws`, `ip-address`) and `sqlite3` (`^5.1.7` $\rightarrow$ `node-gyp` $\rightarrow$ `make-fetch-happen` $\rightarrow$ `basic-ftp`, `@tootallnate/once`):

| Transitive Package | Severity | Parent Package | Exploitability in WaGateway Context | Recommendation |
| :--- | :---: | :--- | :--- | :--- |
| `extract-zip` / `tar-fs` | High | `puppeteer` (via `whatsapp-web.js`) | **Low (Build/Install Time Only):** Used only when Puppeteer downloads Chromium during installation, not exposed to runtime user input. | Upgrade `whatsapp-web.js` / `puppeteer` in a staging environment when testing Chromium compatibility. |
| `basic-ftp` / `@tootallnate/once` | High / Low | `sqlite3` (`node-gyp`) | **Low (Build Time Only):** Used by `node-gyp` during native binary installation; never invoked at runtime. | No runtime impact; monitor `sqlite3` `v6.x` release or migrate to `better-sqlite3`. |
| `qs` / `body-parser` | Moderate | `express` | **Low:** Mitigated by Express body size limit (`2mb`) and current patch resolution. | Run `npm update express` during maintenance windows. |

---

## 7. Remaining Risks & Production Security Checklist

While all code-level vulnerabilities within scope were remediated without breaking Busy Accounting or Frontend functionality, the following architectural items require environment/deployment action by the operations team:

### 7.1 Required Environment Variable Updates (`.env`)
> **IMPORTANT:** Do not use the default `.env` secrets in production. Rotate these immediately on your production server:
1. **`JWT_SECRET`:** Currently set to `whatsapp_gateway_secret_key_2026` in `.env`. Generate a high-entropy 64-byte secret:
   ```bash
   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
   ```
2. **`MASTER_ADMIN_PASSWORD`:** Currently set to `admin123` in `.env`. Replace with a strong 20+ character passphrase in production.
3. **`API_PASSWORD`:** Currently set to `123456` for the default seed tenant. Update via `.env` before initial seeding.
4. **`CORS_ORIGIN`:** Set `CORS_ORIGIN=https://your-production-domain.com` in `.env` if cross-origin browser requests should be restricted to your domain.

### 7.2 Architectural Residual Risks
1. **Plaintext Legacy API Passwords in SQLite (`tenants.password`):**
   - *Why it exists:* The dashboard UI (`GET /api/client/dashboard` and `GET /api/admin/clients`) displays the tenant's generated Busy Accounting `api_password` and pre-fills the copyable Busy integration URL (`?username=...&password=...`). Hashing `tenants.password` with bcrypt would break the ability to display the integration URL in the client dashboard without a "show once on creation / regenerate key" UX change.
   - *Mitigation:* Ensure filesystem permissions on `logs/database.db` and `session/` are restricted to `chmod 600` / `chmod 700` owned exclusively by the service user.
2. **JWT Stored in `localStorage`:**
   - *Why it exists:* The SPA frontend stores `wa_gateway_token` in `localStorage` for both REST `Authorization: Bearer` headers and Socket.IO handshake auth.
   - *Mitigation:* Strictly enforced Content Security Policy (`script-src` without `'unsafe-inline'`) and comprehensive `escapeHtml()` output encoding across `public/dashboard.js` protect against XSS token exfiltration.
3. **Chromium `--no-sandbox` Flag (`services/whatsapp.js`):**
   - *Why it exists:* Required when running headless Chromium inside Docker/root Linux containers.
   - *Mitigation:* Run the Node.js process under a dedicated, non-root OS user account with minimal filesystem privileges.

---

## 8. Concise Summary of Modified Files

| File | Summary of Security Changes |
| :--- | :--- |
| `app.js` | Removed `NODE_TLS_REJECT_UNAUTHORIZED = '0'`; added 25MB `multer` and 2MB `express.json`/`urlencoded` limits; added rate limiters to `/logout` and `/restart`; redacted sensitive query params (`password`, `token`, etc.) in request logs. |
| `controllers/authController.js` | Removed unverified `decodeJwtPayload` and raw email auth bypasses; added cryptographic Firebase ID Token verification (`identitytoolkit.googleapis.com`) + Google OAuth2 `tokeninfo` verification; added constant-time `safeCompare` (`crypto.timingSafeEqual`) for `adminLogin`. |
| `middleware/adminAuth.js` | Replaced string `===` with constant-time `safeCompare` (`crypto.timingSafeEqual` on SHA-256 digests). |
| `middleware/security.js` | Added `authLimiter` (25 req/15m); removed `'unsafe-inline'` from CSP `scriptSrc`; added `objectSrc: ["'none'"]`; fixed CORS `origin: '*'` + `credentials` specification conflict and added `PUT`/`DELETE` methods. |
| `routes/authRoutes.js` | Applied `security.authLimiter` to `POST /api/auth/google` and `POST /api/auth/admin/login`. |
| `routes/systemRoutes.js` | Protected `POST /api/tenants` and `POST /api/admin/credits/recharge` with `adminAuth` middleware. |
| `controllers/systemController.js` | Removed `nodeVersion`/`platformOS` fingerprinting from `/status`; added strict `/^[a-zA-Z0-9_-]{1,64}$/` validation on `tenantId`; sanitized 500 error responses. |
| `controllers/adminController.js` | Hardened `escapeCsvValue()` against CSV Formula Injection (`CWE-1236`). |
| `controllers/chatController.js` | Added `isValidChatId()` format validation and bounded `limit` query parameter to `[1, 200]`. |
| `routes/chatRoutes.js` | Added 25MB `fileSize` and 1-file limit to `multer` instance. |
| `services/whatsapp.js` | Added `sanitizeTenantId()` and canonical base-directory prefix checks in `initClient`, `logoutSession`, and `deleteSessionData` to prevent Path Traversal (`CWE-22`). |
| `services/logService.js` | Added `getSafeLogFilePath()` with canonical path containment checks for fallback JSONL logs. |
| `services/db.js` | Replaced `Math.random()` with CSPRNG `crypto.randomInt()` for `channelId` generation. |
| `services/socketService.js` | Removed hardcoded `'secret'` fallback in Socket.IO JWT verification. |
| `public/dashboard.js` | Escaped all dynamic values/attributes in `renderAdminClientsTable`, `renderWaWebChats`, `selectWaChat`, and `sendMessageForm`; removed inline `onclick` attribute for strict CSP compliance. |
| `tests/security.test.js` | Added 5 regression tests verifying auth bypass prevention, forged JWT rejection, path traversal blocking, CSV formula injection neutralization, and server fingerprinting removal. |
