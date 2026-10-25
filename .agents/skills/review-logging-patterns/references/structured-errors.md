# Structured errors

`createError` from `evlog` carries what failed, why, and how to respond. The backend error handler in `apps/backend/src/app/app.ts` logs the thrown value and returns `parseError` as JSON (`message`, `why`, `fix`, `link`).

```typescript
import { createError } from "evlog"

throw createError({
  message: "resolve-ref failed to fetch",
  why: err.message,
  status: res.status,
  cause: err,
})
```

Use `message` for what failed, `why` for the cause the caller can act on, `status` for the HTTP code, and `cause` for the original error. `fix` and `link` are optional and show up in the JSON body.

Preserve workflow control signals: rethrow those before wrapping. Example: `apps/backend/src/domain/codeIngestion/queue.ts`.
