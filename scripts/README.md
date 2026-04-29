# Scripts

## OAuth refresh probe

Reproduces the same Better Auth OAuth paths MCP uses: dynamic **public** client registration (PKCE), browser login, `authorization_code` exchange, then **`refresh_token`** grant(s). Prints **full JSON error bodies** from `oauth2/token` (including `error_description`) when requests fail.

### Prerequisites

- [Bun](https://bun.sh/) on `PATH` (matches repo `engines.bun`).
- **Do not commit secrets.** Output file `oauth-repro.tokens.json` is gitignored.

### Full flow (production or staging)

From repo root:

```bash
export AUTH_BASE_URL=https://app.ctxpipe.ai
pnpm oauth:refresh-probe
```

Optional: open browser manually (no `open`/`xdg-open`):

```bash
pnpm oauth:refresh-probe -- --no-open
```

Optional: different callback port (must match redirect URI):

```bash
pnpm oauth:refresh-probe -- --port=9876
```

After you sign in in the browser, the script:

1. Exchanges `code` for tokens (with **`resource`** = `{AUTH_BASE_URL}/mcp` so access JWT audience matches MCP).
2. Calls **`refresh_token`** immediately and prints the response.
3. Calls **`refresh_token`** again with the **new** refresh token (rotation behaviour).
4. Writes **`oauth-repro.tokens.json`** in the current working directory (tokens in plaintext locally — delete when done).

### MCP smoke (`initialize`)

Requires an org you belong to:

```bash
export AUTH_BASE_URL=https://app.ctxpipe.ai
export CTXPIPE_ORG_SLUG=your-org-slug
pnpm oauth:refresh-probe -- --mcp
```

Sends a minimal JSON-RPC **`initialize`** to `POST /mcp?orgSlug=...` with the access token from the first successful refresh (or code exchange if refresh failed early).

### Replay refresh only (no browser)

Use saved `client_id` + `refresh_token` (e.g. from `oauth-repro.tokens.json` or Cursor storage — handle as secret):

```bash
export AUTH_BASE_URL=https://app.ctxpipe.ai
pnpm oauth:refresh-probe -- --replay-refresh \
  --client-id='...' \
  --refresh-token='...'
```

Runs two refresh calls in a row to observe rotation / `invalid_grant`.

### Interpreting `oauth2/token` errors

RFC 6749 errors are in the **response JSON**, not always in evlog wide events:

| `error` | Typical meaning |
|---------|-----------------|
| `invalid_grant` | Refresh row missing, revoked, expired, or wrong `client_id` / reused token (`error_description` often `session not found` in Better Auth for missing refresh row). |
| `invalid_client` | Wrong `client_id` or secret (public clients use `token_endpoint_auth_method: none`). |
| `invalid_scope` | Requested scope not allowed for the client. |

### Caveats

- **Dynamic registration** creates rows in **`oauth_clients`** (and tokens in **`oauth_refresh_tokens`**) on the target environment — use staging when possible; delete test clients in production if policy requires.
- **Access JWT TTL** is ~4 hours; this script validates **immediate** refresh, not “wait until expiry” unless you manually use an old refresh token with `--replay-refresh`.
