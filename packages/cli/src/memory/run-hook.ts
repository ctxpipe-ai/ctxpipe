import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveCtxpipeBaseUrl } from "../auth.js"
import { ensureRepoStateDir, runtimeStateFile } from "./paths.js"
import { detectRepoFingerprint } from "./paths.js"

/**
 * Lifecycle hook entrypoint. Invoked by agent-native hook configs (Claude Code,
 * etc.) — must exit fast and never block the agent.
 *
 * For v1 we drop a JSON marker into the per-repo state dir so other parts of
 * the system can observe that a session started/ended. Heavier work (summaries,
 * consolidation, graph extraction) is deferred to the supervisor and runs when
 * hosted model access is available.
 */
export async function runMemoryHook(opts: {
  name: string
  baseUrl: string
}): Promise<void> {
  const baseUrl = resolveCtxpipeBaseUrl(process.cwd(), opts.baseUrl)
  const fingerprint = detectRepoFingerprint(process.cwd())
  const stateDir = ensureRepoStateDir(fingerprint)
  const event = {
    name: opts.name,
    baseUrl,
    cwd: process.cwd(),
    at: new Date().toISOString(),
  }
  const eventsFile = join(stateDir, "hook-events.jsonl")
  try {
    writeFileSync(eventsFile, `${JSON.stringify(event)}\n`, { flag: "a" })
  } catch {
    // hooks must never throw — they would break the agent session
  }
  // Touch the runtime file modification time so the supervisor can pick up the
  // event on the next memory tool call without us having to run a long-lived
  // worker here.
  const runtimeFile = runtimeStateFile(fingerprint)
  try {
    writeFileSync(runtimeFile, "", { flag: "a" })
  } catch {
    // best effort
  }
  process.stdout.write(JSON.stringify({ status: "ok", event: opts.name }))
}
