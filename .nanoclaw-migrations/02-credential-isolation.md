# 02 — Credential Isolation (Native Proxy + Google Token Vendor)

**Intent:** Containers never see real Anthropic or Google credentials. Two host-side microservices vend auth into the container at request time:
1. **Credential proxy** (port 3001) — reverse-proxies Anthropic API; injects real `x-api-key` or real OAuth bearer.
2. **Google token vendor** (port 3002) — `POST /token {scope}` → `{access_token, expires_at}`, never returns refresh tokens or client secrets.

This replaces upstream's OneCLI gateway for this fork. On v2, check whether v2 ships OneCLI integration natively — if so, decide whether to layer this on top or replace v2's credential story with this one. **Recommendation:** if v2's approach is equivalent, use v2's; if v2 still requires OneCLI host install, keep this native version so the user doesn't have to install OneCLI.

## Credential proxy

**Files:**
- `src/credential-proxy.ts` (+ `.test.ts`) — the HTTP server. Map to v2 equivalent path.
- `src/env.ts` (+ `.test.ts`) — the `.env` parser that does NOT mutate `process.env`.

**How to apply:**

1. Create `env.ts` with `readEnvFile(keys: string[]): Record<string, string>` that parses `.env` in project root and returns the requested keys as a dict. Do not set `process.env[...]`. This is the contract: secrets stay out of any child process environment.

2. Create `credential-proxy.ts` with:
   - HTTP listener on `CREDENTIAL_PROXY_PORT` (default 3001), bound to `CREDENTIAL_PROXY_HOST` (auto-detected: macOS/WSL → `127.0.0.1`; bare Linux → docker0 bridge IP, fallback `0.0.0.0`).
   - **Path allowlist:** only forward `/v1/messages` and `/api/oauth/claude_cli/create_api_key`. All other paths → 403.
   - **Header allowlist:** only forward `content-type`, `accept`, `anthropic-version`, `anthropic-beta`, `x-api-key`, `authorization`. Strip everything else. Always set `host` to upstream hostname.
   - **Dual auth modes:**
     - **API-key mode** (if `ANTHROPIC_API_KEY` present): inject `x-api-key: {real_key}` on every forwarded request.
     - **OAuth mode** (if `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN` present): only on requests with `Authorization: Bearer` header, replace the placeholder bearer with the real OAuth token. `/v1/messages` calls after the initial exchange use a temp API key returned by the create_api_key endpoint — no bearer replacement needed there.
   - **Upstream:** `ANTHROPIC_BASE_URL` (default `https://api.anthropic.com`). Detect http vs https from the URL, use `https.request` for https (with `https-proxy-agent` if `https_proxy`/`HTTPS_PROXY` env vars set), plain `http.request` for http.
   - **Error semantics:** upstream connection failure → 502 Bad Gateway with the error message; disallowed path → 403; disallowed auth source → 500.

3. Containers point `ANTHROPIC_BASE_URL=http://host.docker.internal:3001` (passed as env var in `container-runner`). On Linux, the host gateway needs `--add-host=host.docker.internal:host-gateway` (handled by `hostGatewayArgs()` in `container-runtime.ts`).

## Google token vendor

**Files:**
- `src/google-token-vendor.ts` (+ `.test.ts`)

**How to apply:**

1. HTTP listener on `GOOGLE_TOKEN_VENDOR_PORT` (default 3002), bound to `CREDENTIAL_PROXY_HOST` (same detection logic).
2. Accept `POST /token` with body `{scope: "readonly" | "readwrite"}`. Reject other paths/methods.
3. Load creds from `~/.nanoclaw-google-mcp/`:
   - OAuth app: `oauth-{scope}.json` (supports both `installed` and `web` OAuth app types — the JSON shape varies; handle both)
   - Tokens: `{scope}-credentials.json` (googleapis `Credentials` object with access_token, refresh_token, expiry_date)
4. Per-scope in-memory cache. If cached token's `expires_at - now < EXPIRY_BUFFER_MS (60s)`, refresh via `OAuth2Client.refreshAccessToken()`.
5. On refresh, merge new credentials with stored ones, preserving `refresh_token` from stored copy if the OAuth response omits it.
6. Response: `{access_token, expires_at}` only. Never return `refresh_token`, `client_id`, or `client_secret`.
7. Errors: 503 (missing creds, refresh failure), 400 (invalid scope).

## Container wiring

**Files affected:**
- `src/container-runner.ts` equivalent on v2 — compute the URLs and pass as env vars to container.
- Agent-runner mcpServers entry for `google` uses `NANOCLAW_GOOGLE_TOKEN_URL`.

**Env vars to pass into container:**
- `ANTHROPIC_BASE_URL=http://host.docker.internal:${CREDENTIAL_PROXY_PORT}` (or whatever host gateway IP is computed)
- `NANOCLAW_GOOGLE_TOKEN_URL=http://host.docker.internal:${GOOGLE_TOKEN_VENDOR_PORT}/token`
- `PROXY_BIND_HOST` — only if container needs to know its own host IP for callbacks (rare).

**Env vars for proxy upstream (read from host `.env` via `readEnvFile`, NOT `process.env`):**
- `ANTHROPIC_API_KEY` (API-key mode)
- `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_AUTH_TOKEN` (OAuth mode)
- `ANTHROPIC_BASE_URL` (default https://api.anthropic.com)
- Upstream proxy: `https_proxy` / `HTTPS_PROXY` / `http_proxy` / `HTTP_PROXY`

## Orchestrator startup

In `src/index.ts` equivalent on v2:
```typescript
await startGoogleTokenVendor();
await startCredentialProxy();
```
Both before any container spawn. Remove any OneCLI / `ensureOneCLIAgent()` / `new OneCLI()` calls from the fork's orchestrator if that pattern exists on v2's `main` (v2 may already have moved past OneCLI).

## Ack timeouts depend on this

`src/ack.ts` (see `04-router-and-security.md` — actually covered here since it's purely a proxy dependency) calls Haiku via the credential proxy so it inherits auth mode without duplicating logic. Must use the same proxy port.

## Testing checklist for Stage 2

- [ ] `readEnvFile` returns expected keys without setting `process.env`
- [ ] Proxy rejects `/v1/health` and other non-allowlisted paths with 403
- [ ] Proxy strips `user-agent`, `x-request-id`, and arbitrary headers; only allowlist forwarded
- [ ] With `ANTHROPIC_API_KEY`: container-side `curl -H 'anthropic-version: 2023-06-01' http://host.docker.internal:3001/v1/messages` reaches Anthropic
- [ ] Without any auth env var: proxy returns 500 on startup (refuse to start insecure)
- [ ] Token vendor returns `access_token` only; no `refresh_token` in response body ever
- [ ] Token vendor refreshes 60s before expiry (simulate by setting `expiry_date` to 30s from now)
- [ ] Invalid scope → 400; missing creds file → 503

## Migration risk

- **High:** v2 may have its own credential story. If v2 ships with `OneCLI Agent Vault` or similar, there's likely conflict. Resolve BEFORE implementing this stage: does the user want this native proxy or OneCLI? The `init-onecli` operational skill exists — if v2 centers on OneCLI, the native proxy becomes redundant.
- **Medium:** `host.docker.internal` resolution on Linux. The `--add-host=host.docker.internal:host-gateway` trick works on Docker 20.10+. Apple Container may have different semantics; test in-stage.
- **Low:** Port conflicts. 3001/3002 are arbitrary; make them overrideable via env.
