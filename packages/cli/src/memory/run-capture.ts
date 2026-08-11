import {
  acknowledgeSurfaced,
  markDismissed,
  markPromoted,
  observeCapture,
  parseHost,
  readStdinJson,
  summarizeCapture,
} from "./capture.js"

function writeStdoutJson(payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = process.stdout.write(`${JSON.stringify(payload)}\n`, (err) => {
      if (err) reject(err)
      else resolve()
    })
    // If write returned false, wait for drain so we do not ack before the
    // kernel accepts the buffer (backpressure). Callback still fires either way.
    if (!ok) {
      process.stdout.once("error", reject)
    }
  })
}

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
    await writeStdoutJson({
      priority: result.priority,
      message: result.message,
      followup_message: result.priority === "low" ? undefined : result.message,
      candidates: result.candidates,
    })
    // Only after confirmed stdout delivery — never hide candidates the host did not see.
    acknowledgeSurfaced(result.surfacedIds)
  } catch {
    try {
      await writeStdoutJson({
        priority: "low",
        message: "Memory capture summary unavailable.",
        candidates: [],
      })
    } catch {
      // fail-open
    }
  }
  process.exitCode = 0
}

/** Observe stdin then summarize in one process (Claude Stop handlers race if split). */
export async function runMemoryCaptureFinalize(opts: {
  host: string
  event: string
}): Promise<void> {
  try {
    const payload = await readStdinJson()
    observeCapture({
      host: parseHost(opts.host),
      eventType: opts.event || "Stop",
      payload,
    })
  } catch {
    // fail-open on observe
  }
  await runMemoryCaptureSummary()
}

export async function runMemoryCapturePromote(ids: string[]): Promise<void> {
  try {
    markPromoted(ids)
    await writeStdoutJson({ ok: true, promoted: ids })
  } catch {
    process.exitCode = 1
    return
  }
  process.exitCode = 0
}

export async function runMemoryCaptureDismiss(ids: string[]): Promise<void> {
  try {
    markDismissed(ids)
    await writeStdoutJson({ ok: true, dismissed: ids })
  } catch {
    process.exitCode = 1
    return
  }
  process.exitCode = 0
}
