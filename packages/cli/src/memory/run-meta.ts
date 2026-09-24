import { existsSync } from "node:fs"
import { join } from "node:path"
import { log, note } from "@clack/prompts"
import { resolveCtxpipeBaseUrl } from "../auth.js"
import { resolveMemoryRoot, resolveRepoRoot } from "./paths.js"
import { type UncommittedMemory, uncommittedMemory } from "./uncommitted.js"

export async function runMemoryStatus(opts: {
  baseUrl: string
  json: boolean
}): Promise<void> {
  const cwd = resolveRepoRoot()
  const baseUrl = resolveCtxpipeBaseUrl(cwd, opts.baseUrl)
  const state = collectStatus(baseUrl)
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
  const cwd = resolveRepoRoot()
  const baseUrl = resolveCtxpipeBaseUrl(cwd, opts.baseUrl)
  const status = collectStatus(baseUrl)
  const checks = collectDoctorChecks(status)
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ...status, checks }, null, 2)}\n`)
    return
  }
  note(
    [formatStatusText(status), "", "Checks:", ...checks.map(formatCheck)].join(
      "\n",
    ),
    "ctx| memory doctor",
  )
}

export async function runMemoryStop(opts: { json: boolean }): Promise<void> {
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({
        status: "noop",
        detail: "No local memory runtime to stop (Markdown-only mode).",
      })}\n`,
    )
    return
  }
  log.info("No local memory runtime to stop (Markdown-only mode, ADR-024).")
}

type StatusSnapshot = {
  baseUrl: string
  cwd: string
  memoryRoot: string
  memoryRootExists: boolean
  indexExists: boolean
  eventsDirExists: boolean
  /** null outside a git repository. */
  uncommitted: UncommittedMemory | null
  mode: "markdown-only"
}

function collectStatus(baseUrl: string): StatusSnapshot {
  const cwd = resolveRepoRoot()
  const memoryRoot = resolveMemoryRoot(cwd)
  return {
    baseUrl,
    cwd,
    memoryRoot,
    memoryRootExists: existsSync(memoryRoot),
    indexExists: existsSync(join(memoryRoot, "index.md")),
    eventsDirExists: existsSync(join(memoryRoot, "events")),
    uncommitted: uncommittedMemory(cwd),
    mode: "markdown-only",
  }
}

type DoctorCheck = {
  name: string
  status: "ok" | "warn" | "error"
  detail: string
}

function collectDoctorChecks(status: StatusSnapshot): DoctorCheck[] {
  return [
    {
      name: "memory-root",
      status: status.memoryRootExists ? "ok" : "warn",
      detail: status.memoryRootExists
        ? `${status.memoryRoot} present`
        : `${status.memoryRoot} missing — run \`npx ctxpipe memory init\``,
    },
    {
      name: "index",
      status: status.indexExists ? "ok" : "warn",
      detail: status.indexExists
        ? "index.md present"
        : "index.md missing — re-run memory init or create from seed",
    },
    {
      name: "events",
      status: status.eventsDirExists ? "ok" : "warn",
      detail: status.eventsDirExists
        ? "events/ present (gitignored candidate inbox)"
        : "events/ missing — re-run memory init",
    },
    uncommittedCheck(status.uncommitted),
  ]
}

function uncommittedCheck(uncommitted: UncommittedMemory | null): DoctorCheck {
  if (!uncommitted) {
    return {
      name: "uncommitted",
      status: "warn",
      detail: "not a git repository — memory cannot be committed or shared",
    }
  }
  if (uncommitted.files.length === 0) {
    return {
      name: "uncommitted",
      status: "ok",
      detail: "durable memory is committed",
    }
  }
  return {
    name: "uncommitted",
    status: "warn",
    detail: `${uncommitted.files.join(", ")} uncommitted on ${uncommitted.branch} — commit with the work they came from`,
  }
}

function formatStatusText(state: StatusSnapshot): string {
  return [
    `mode:           ${state.mode}`,
    `memory root:    ${state.memoryRoot}${state.memoryRootExists ? "" : " (missing)"}`,
    `index.md:       ${state.indexExists ? "yes" : "missing"}`,
    `events/:        ${state.eventsDirExists ? "yes" : "missing"}`,
    `uncommitted:    ${state.uncommitted ? state.uncommitted.files.length : "n/a (not a git repository)"}`,
  ].join("\n")
}

function formatCheck(check: DoctorCheck): string {
  const badge = check.status === "ok" ? "✓" : check.status === "warn" ? "!" : "✗"
  return `  ${badge} ${check.name}: ${check.detail}`
}
