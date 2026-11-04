import { SpanStatusCode, trace } from "@opentelemetry/api"

/**
 * An outside call (a Vercel API request, a sandbox command, a GitHub request)
 * that did not finish before its deadline. The message names the call.
 */
export class CallDeadlineError extends Error {
  override readonly name = "CallDeadlineError"

  constructor(call: string, ms: number) {
    super(`${call} did not finish within ${ms / 1000} s`)
  }
}

/**
 * Run one outside call with its own deadline. At the deadline, the signal of
 * the call aborts and the returned promise rejects with a `CallDeadlineError`.
 * The promise also rejects when the call does not obey the signal.
 *
 * Why: the Vercel SDK reads the response of a sandbox command as one stream,
 * with no body timeout (`bodyTimeout: 0`). When that stream stops, the
 * command never ends by itself (CTX-1122, CTX-1094).
 *
 * Each call has a `deadline.call` span. The span records the call name, the
 * deadline, and whether the deadline fired. Thus you can compare each
 * deadline with the real durations of its call.
 */
export function withinDeadline<T>(
  call: string,
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return trace.getTracer("ctxpipe-backend").startActiveSpan(
    "deadline.call",
    {
      attributes: {
        "ctxpipe.call.name": call,
        "ctxpipe.call.deadline_ms": ms,
      },
    },
    async (span) => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      let fired = false
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          fired = true
          const error = new CallDeadlineError(call, ms)
          controller.abort(error)
          reject(error)
        }, ms)
      })
      try {
        return await Promise.race([run(controller.signal), expired])
      } catch (error) {
        // The error type only: a message can hold command output.
        span.setAttribute(
          "error.type",
          error instanceof Error ? error.name : "Error",
        )
        span.setStatus({ code: SpanStatusCode.ERROR })
        throw error
      } finally {
        clearTimeout(timer)
        span.setAttribute("ctxpipe.call.deadline_fired", fired)
        span.end()
      }
    },
  )
}
