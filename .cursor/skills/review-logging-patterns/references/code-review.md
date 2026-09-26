# Logging review

Check these on a backend or codesearch diff:

1. New logs call `getLogger()` or `log` from `src/observability/logger.ts`.
2. A request handler accumulates with `set` on the request logger and emits once (the middleware emits).
3. Failures use `getLogger().error(err, { step })` or `log.error(err, { step })`, with the original error as `cause` when rethrown via `createError`.
4. The diff does not add a drain, a second `evlog()` middleware, or a direct OTLP POST outside `createEvlogDrain()`.
5. Events carry ids. Email, name, IP, tokens, and query strings are absent. Keys match [ADR-011](../../../../.ai/memory/decisions/ADR-011-backend-observability-otel.md) decision 6.
6. A UI change that logs in the browser goes through `evlog/client` (`useAuthEvlogIdentity`), not `console`.
