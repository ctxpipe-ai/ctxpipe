/**
 * The rate limits of Agent Vault wherever ctxpipe runs it: the AWS sandbox
 * host (this package), Compose (`x-agent-vault-limits` in
 * docker-compose.yml, kept equal by a backend test), and the backend's
 * contract tests. Hosted production sets the same `AUTH` and `LOCK` values in
 * the factory repo.
 *
 * - `PROXY`: all sandboxes of a turn share one vault, so the proxy tier is
 *   raised.
 * - `AUTH`: the pre-auth gate is off (CTO decision, CTX-1472). With the
 *   stock gate, 50 proxy-auth failures in 5 minutes from one peer address
 *   refuse each CONNECT from that address with 429. Many sandboxes share one
 *   address behind a load balancer, so one sandbox could lock out the
 *   sandboxes of every organization. `MAX` is the largest value that Agent
 *   Vault parses (a Go `int`). The 1-second window keeps the failure history
 *   of a key small: the global tier (2,000 requests per second) limits it.
 *   The same tier limits the anonymous API endpoints (login, registration,
 *   password reset). On AWS, only the backend and the worker reach the API.
 *   In host dev, local containers reach it too. Each owner password is
 *   random.
 * - `LOCK`: an instance setting (UI or API) cannot change these values. A
 *   setting overrides an environment value otherwise.
 */
export const AGENT_VAULT_RATE_LIMIT_ENV = {
  AGENT_VAULT_RATELIMIT_PROXY_RATE: "200",
  AGENT_VAULT_RATELIMIT_PROXY_BURST: "2000",
  AGENT_VAULT_RATELIMIT_PROXY_CONCURRENCY: "256",
  AGENT_VAULT_RATELIMIT_AUTH_MAX: "9223372036854775807",
  AGENT_VAULT_RATELIMIT_AUTH_WINDOW: "1s",
  AGENT_VAULT_RATELIMIT_LOCK: "true",
} as const
