import {
  acknowledgeSurfaced,
  extractWorkspaceCwd,
  formatStopHookOutput,
  markDismissed,
  markPromoted,
  observeCapture,
  parseHost,
  readStdinJson,
  summarizeCapture,
  type CaptureHost,
} from "./capture.js"

function writeStdoutJson(payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = process.stdout.write(`${JSON.stringify(payload)}\n`, (err) => {
      if (err) reject(err)
      else resolve()
    })
    if (!ok) {
      process.stdout.once("error", reject)
    }
  })
}

async function writeStopStdout(
  host: CaptureHost,
  cwd: string | undefined,
  payload: Record<string, unknown>,
): Promise<void> {
  let delivered = false
  try {
    const result = summarizeCapture({ cwd, host })
    const output = formatStopHookOutput(host, result, payload)
    await writeStdoutJson(output)
    delivered = true
    // Only after confirmed delivery, and only when the host received candidate text.
    if (Object.keys(output).length > 0 && result.surfacedIds.length > 0) {
      acknowledgeSurfaced(result.surfacedIds, { cwd })
    }
  } catch {
    // Never emit a second JSON document after a successful write (hosts parse one object).
    if (!delivered) {
      try {
        await writeStdoutJson({})
      } catch {
        // fail-open
      }
    }
  }
}

/** Read stdin JSON only when piped; interactive TTY must not hang waiting for EOF. */
async function readOptionalStdinJson(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {}
  try {
    return await readStdinJson()
  } catch {
    return {}
  }
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
  const payload = await readOptionalStdinJson()
  const cwd = extractWorkspaceCwd(payload)
  // Manual/summary fallback uses Cursor followup shape unless a host is implied.
  await writeStopStdout("cursor", cwd, payload)
  process.exitCode = 0
}

/** Single Stop handler: observe stdin payload then summarize (serialized). */
export async function runMemoryCaptureFinalize(opts: {
  host: string
  event: string
}): Promise<void> {
  const host = parseHost(opts.host)
  let payload: Record<string, unknown> = {}
  try {
    // Hooks always pipe JSON; still tolerate empty/TTY for local debugging.
    payload = await readOptionalStdinJson()
    observeCapture({
      host,
      eventType: opts.event || "Stop",
      payload,
    })
  } catch {
    // fail-open: still attempt summary so prior candidates can surface
  }
  const cwd = extractWorkspaceCwd(payload)
  await writeStopStdout(host, cwd, payload)
  process.exitCode = 0
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
