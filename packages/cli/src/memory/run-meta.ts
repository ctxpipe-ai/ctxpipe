import { existsSync, readFileSync } from "node:fs"
import { log, note } from "@clack/prompts"
import { readStoredAuth } from "../auth.js"
import { detectRepoFingerprint, runtimeStateFile } from "./paths.js"
import type { RuntimeState } from "./supervisor.js"
import { resolveMemoryRoot } from "./paths.js"
import { computeManifestStats } from "./hydration.js"

export async function runMemoryStatus(opts: {
  baseUrl: string
  json: boolean
}): Promise<void> {
  const state = await collectStatus(opts.baseUrl)
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
    return
  }
  note(formatStatusText(state), "ctx| memory status")
}

export async function runMemoryDoctor(opts: {
  baseUrl: string
  json: boolean
}): Promise<void> {
  const status = await collectStatus(opts.baseUrl)
  const checks = await collectDoctorChecks(status)
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ...status, checks }, null, 2)}\n`)
    return
  }
  note(
    [formatStatusText(status), "", "Checks:", ...checks.map(formatCheck)].join("\n"),
    "ctx| memory doctor",
  )
}

export async function runMemoryStop(opts: { json: boolean }): Promise<void> {
  const fingerprint = detectRepoFingerprint(process.cwd())
  const file = runtimeStateFile(fingerprint)
  if (!existsSync(file)) {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ status: "noop" }, null, 2)}\n`)
      return
    }
    log.info("No managed AgentMemory runtime is recorded for this repo.")
    return
  }
  const runtime = JSON.parse(readFileSync(file, "utf8")) as RuntimeState
  try {
    process.kill(runtime.pid, "SIGTERM")
  } catch {
    // already gone
  }
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ status: "stopped", pid: runtime.pid }, null, 2)}\n`,
    )
    return
  }
  log.success(`Stopped AgentMemory runtime (pid ${runtime.pid}).`)
}

type StatusSnapshot = {
  baseUrl: string
  cwd: string
  repoFingerprint: string
  memoryRoot: string
  memoryRootExists: boolean
  runtime: RuntimeState | null
  signedIn: boolean
  hostedModel: "available" | "signed-out"
  manifest: ReturnType<typeof computeManifestStats>
}

async function collectStatus(baseUrl: string): Promise<StatusSnapshot> {
  const cwd = process.cwd()
  const fingerprint = detectRepoFingerprint(cwd)
  const runtimeFile = runtimeStateFile(fingerprint)
  let runtime: RuntimeState | null = null
  if (existsSync(runtimeFile)) {
    try {
      runtime = JSON.parse(readFileSync(runtimeFile, "utf8")) as RuntimeState
    } catch {
      runtime = null
    }
  }
  const memoryRoot = resolveMemoryRoot(cwd)
  const auth = await readStoredAuth(baseUrl)
  const signedIn = Boolean(auth?.accessToken)
  const manifest = computeManifestStats(fingerprint)
  return {
    baseUrl,
    cwd,
    repoFingerprint: fingerprint,
    memoryRoot,
    memoryRootExists: existsSync(memoryRoot),
    runtime,
    signedIn,
    hostedModel: signedIn ? "available" : "signed-out",
    manifest,
  }
}

type DoctorCheck = {
  name: string
  status: "ok" | "warn" | "error"
  detail: string
}

async function collectDoctorChecks(status: StatusSnapshot): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []

  checks.push({
    name: "memory-root",
    status: status.memoryRootExists ? "ok" : "warn",
    detail: status.memoryRootExists
      ? `${status.memoryRoot} present`
      : `${status.memoryRoot} missing — run \`npx ctxpipe init --memory\``,
  })

  checks.push({
    name: "auth",
    status: status.signedIn ? "ok" : "warn",
    detail: status.signedIn
      ? "ctx| setup auth available; hosted model proxy enabled"
      : "no ctx| setup auth — local memory still works in no-LLM mode (`npx ctxpipe auth login`)",
  })

  checks.push({
    name: "runtime",
    status: status.runtime ? "ok" : "warn",
    detail: status.runtime
      ? `AgentMemory ${status.runtime.agentmemoryVersion} pid ${status.runtime.pid} at ${status.runtime.url}`
      : "no managed AgentMemory runtime is currently recorded (lazy-spawn happens on first MCP call)",
  })

  checks.push({
    name: "hydration-manifest",
    status: status.manifest.exists ? "ok" : "warn",
    detail: status.manifest.exists
      ? `${status.manifest.fileCount} tracked files, ${status.manifest.memoryCount} memories`
      : "no manifest yet (will be created on first hydration)",
  })

  return checks
}

function formatStatusText(state: StatusSnapshot): string {
  return [
    `mode:           ${state.signedIn ? "signed-in" : "local-only"}`,
    `memory root:    ${state.memoryRoot} ${state.memoryRootExists ? "" : "(missing)"}`.trim(),
    `runtime:        ${state.runtime ? `${state.runtime.url} (pid ${state.runtime.pid})` : "not started"}`,
    `hosted model:   ${state.hostedModel}`,
    `manifest:       ${state.manifest.exists ? `${state.manifest.fileCount} files, ${state.manifest.memoryCount} memories` : "not yet built"}`,
  ].join("\n")
}

function formatCheck(check: DoctorCheck): string {
  const badge = check.status === "ok" ? "✓" : check.status === "warn" ? "!" : "✗"
  return `  ${badge} ${check.name}: ${check.detail}`
}
