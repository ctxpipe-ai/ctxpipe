/**
 * An outside call (a Vercel API request, a sandbox command, a GitHub request)
 * that did not finish before its deadline. The message names the call.
 */
export class CallDeadlineError extends Error {
  override readonly name = "CallDeadlineError"

  constructor(
    readonly call: string,
    readonly ms: number,
  ) {
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
 */
export async function withinDeadline<T>(
  call: string,
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new CallDeadlineError(call, ms)
      controller.abort(error)
      reject(error)
    }, ms)
  })
  try {
    return await Promise.race([run(controller.signal), expired])
  } finally {
    clearTimeout(timer)
  }
}
