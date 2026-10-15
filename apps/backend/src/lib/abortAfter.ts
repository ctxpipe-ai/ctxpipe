/** An abort controller that aborts itself after `ms` milliseconds. */
export function abortAfter(ms: number): AbortController {
  const controller = new AbortController()
  AbortSignal.timeout(ms).addEventListener("abort", () => controller.abort(), {
    once: true,
  })
  return controller
}
