import {
  acknowledgeSurfaced,
  extractWorkspaceCwd,
  formatStopHookOutput,
  markDismissed,
  markPromoted,
  observeCapture,
  parseHost,
  readStdinJson,
  resolveRepoRoot,
  summarizeCapture,
  type CaptureHost,
} from "./capture.js"
import { resolveCaptureHost } from "./harness.js"

function hostFor(
  flag: string,
  payload: Record<string, unknown>,
): CaptureHost | null {
  return resolveCaptureHost(
    parseHost(flag),
    payload,
    resolveRepoRoot(extractWorkspaceCwd(payload)),
  )
}

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
    // Only after confirmed delivery, and only when the host received the text.
    if (
      Object.keys(output).length > 0 &&
      (result.surfacedIds.length > 0 || result.uncommittedKey)
    ) {
      acknowledgeSurfaced(result.surfacedIds, {
        cwd,
        uncommittedKey: result.uncommittedKey,
      })
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
    const host = hostFor(opts.host, payload)
    if (!host) return
    const result = observeCapture({
      host,
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
  // Hooks always pipe JSON; still tolerate empty/TTY for local debugging.
  const payload = await readOptionalStdinJson()
  const host = hostFor(opts.host, payload)
  if (!host) {
    try {
      await writeStdoutJson({})
    } catch {
      // fail-open
    }
    process.exitCode = 0
    return
  }
  try {
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
