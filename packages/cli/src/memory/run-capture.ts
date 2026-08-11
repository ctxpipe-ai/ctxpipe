import { observeCapture, parseHost, readStdinJson, summarizeCapture } from "./capture.js"

export async function runMemoryCaptureObserve(opts: {
  host: string
  event: string
}): Promise<void> {
  try {
    const payload = await readStdinJson()
    const result = observeCapture({
      host: parseHost(opts.host),
      eventType: opts.event || "unknown",
      payload,
    })
    if (process.env.CTXPIPE_MEMORY_CAPTURE_DEBUG === "1") {
      process.stderr.write(`${JSON.stringify(result)}\n`)
    }
  } catch {
    // fail-open: never break the host agent session
  }
  process.exitCode = 0
}

export async function runMemoryCaptureSummary(): Promise<void> {
  try {
    const result = summarizeCapture()
    process.stdout.write(
      `${JSON.stringify({
        priority: result.priority,
        message: result.message,
        followup_message: result.priority === "low" ? undefined : result.message,
        candidates: result.candidates,
      })}\n`,
    )
  } catch {
    process.stdout.write(
      `${JSON.stringify({
        priority: "low",
        message: "Memory capture summary unavailable.",
        candidates: [],
      })}\n`,
    )
  }
  process.exitCode = 0
}
