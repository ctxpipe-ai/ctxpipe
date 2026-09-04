import { AsyncLocalStorage } from "node:async_hooks"
import {
  formatUnknownError,
  isTransientDbConnectionError,
} from "../db/transientDbRetry.js"

type AuthApiErrorState = {
  transientDatabaseError: string | null
}

const authApiErrorStorage = new AsyncLocalStorage<AuthApiErrorState>()

export function transientAuthUnavailableResponse(): Response {
  return Response.json(
    {
      error: "temporarily_unavailable",
      message:
        "ctx| authentication is temporarily unavailable. Try again shortly.",
    },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": "3",
      },
    },
  )
}

export function recordAuthApiError(error: unknown): void {
  if (!isTransientDbConnectionError(error)) return
  const state = authApiErrorStorage.getStore()
  if (state) state.transientDatabaseError = formatUnknownError(error)
}

export async function captureAuthApiErrors<T>(run: () => Promise<T>): Promise<
  | {
      ok: true
      value: T
      transientDatabaseError: string | null
    }
  | {
      ok: false
      error: unknown
      transientDatabaseError: string | null
    }
> {
  const state: AuthApiErrorState = { transientDatabaseError: null }
  return authApiErrorStorage.run(state, async () => {
    try {
      const value = await run()
      return {
        ok: true,
        value,
        transientDatabaseError: state.transientDatabaseError,
      }
    } catch (error) {
      recordAuthApiError(error)
      return {
        ok: false,
        error,
        transientDatabaseError: state.transientDatabaseError,
      }
    }
  })
}
