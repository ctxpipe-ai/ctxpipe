import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join, resolve as pathResolve } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"

export type CaptureHost = "cursor" | "claude" | "codex" | "opencode" | "vscode" | "unknown"

export type ClassificationKind = "lesson" | "decision" | "requirement" | "glossary"

export type Classification = {
  kind: ClassificationKind
  destination: string
  action: string
  confidence: "high" | "medium"
}

const CLASSIFIERS: Array<{
  kind: ClassificationKind
  destination: string
  action: string
  patterns: RegExp[]
}> = [
  {
    kind: "lesson",
    destination: ".ai/memory/lessons-learned.md",
    action: "Append a lesson with Rule / Category / Date / Source",
    patterns: [
      /\b(always|never|from now on|make sure you|don't|do not|stop doing)\b/i,
      /\b(prefer|avoid)\b.+\b(always|never)\b/i,
    ],
  },
  {
    kind: "decision",
    destination: ".ai/memory/decisions/",
    action: "Capture via capture-adr or capture-decision skill; update decisions/index.md",
    patterns: [
      /\b(we (decided|chose|picked)|decision:|out of scope|approved)\b/i,
      /\b(going with|will use|won't use)\b/i,
    ],
  },
  {
    kind: "requirement",
    destination: ".ai/memory/PRDs/",
    action: "Update or create a PRD; update PRDs/index.md",
    patterns: [
      /\b(acceptance criteria|must |edge case|non-goal|requirement)\b/i,
    ],
  },
  {
    kind: "glossary",
    destination: ".ai/memory/glossary.md",
    action: "Add a glossary term; keep glossary.md in sync",
    patterns: [
      /\b(we call (this|that)|means in this (project|repo)|glossary)\b/i,
    ],
  },
]

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/<private>[\s\S]*?<\/private>/gi, "[REDACTED]"],
  [
    /\b(api[_-]?key|secret|token|password|passwd|authorization)\s*[:=]\s*['"]?[^\s'"]+/gi,
    "$1=[REDACTED_SECRET]",
  ],
  [/\bBearer\s+[A-Za-z0-9._\-+=/]+/gi, "Bearer [REDACTED_SECRET]"],
  [/\bsk-(?:ant|proj)-[A-Za-z0-9_-]+/g, "[REDACTED_SECRET]"],
  [/\bgh[pous]_[A-Za-z0-9_]+/g, "[REDACTED_SECRET]"],
  [/\bgithub_pat_[A-Za-z0-9_]+/g, "[REDACTED_SECRET]"],
  [/\bAKIA[0-9A-Z]{16}/g, "[REDACTED_SECRET]"],
  [/\bAIza[0-9A-Za-z_-]{35}/g, "[REDACTED_SECRET]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_SECRET]"],
]

const DENY_PATH_FRAGMENTS = [
  ".env",
  "credentials",
  "secrets",
  "keychain",
  "node_modules",
  ".git/",
]

const SELF_CAPTURE_RE =
  /memory capture|memory-capture|capture\.ts|capture-adr|capture-lesson|capture-glossary|capture-decision/i

const MAX_TEXT = 2000
const MAX_EXCERPT = 700

export function resolveRepoRoot(cwd = process.cwd()): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  })
  if (result.status === 0 && result.stdout) return result.stdout.trim()
  return cwd
}

export function memoryRoot(repoRoot: string): string {
  return join(repoRoot, ".ai", "memory")
}

export function eventsRoot(repoRoot: string): string {
  return join(memoryRoot(repoRoot), "events")
}

export function redactText(input: string): { text: string; redacted: boolean } {
  let text = input
  let redacted = false
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    const next = text.replace(pattern, replacement)
    if (next !== text) redacted = true
    text = next
  }
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}…`
  return { text, redacted }
}

function filterFiles(files: unknown): string[] {
  if (!Array.isArray(files)) return []
  return files
    .filter((f): f is string => typeof f === "string")
    .filter(
      (f) =>
        !DENY_PATH_FRAGMENTS.some((frag) => f.toLowerCase().includes(frag)),
    )
    .slice(0, 20)
}

export function classifyText(text: string): Classification[] {
  const hits: Classification[] = []
  for (const c of CLASSIFIERS) {
    if (c.patterns.some((p) => p.test(text))) {
      hits.push({
        kind: c.kind,
        destination: c.destination,
        action: c.action,
        confidence: "medium",
      })
    }
  }
  return hits
}

function ensureEventsDir(repoRoot: string): string {
  const root = eventsRoot(repoRoot)
  const daily = join(root, "events")
  mkdirSync(daily, { recursive: true })
  const keep = join(root, ".gitkeep")
  if (!existsSync(keep)) writeFileSync(keep, "")
  return root
}

function dayStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}

function extractPrompt(payload: Record<string, unknown>): string {
  const keys = ["prompt", "userPrompt", "message", "text", "content"]
  for (const k of keys) {
    const v = payload[k]
    if (typeof v === "string" && v.trim()) return v
  }
  const prompt = payload.prompt
  if (prompt && typeof prompt === "object" && prompt !== null) {
    const p = prompt as Record<string, unknown>
    if (typeof p.text === "string") return p.text
  }
  return ""
}

function extractToolBits(payload: Record<string, unknown>): {
  toolName: string
  toolInput: string
  toolOutput: string
} {
  const toolName =
    (typeof payload.toolName === "string" && payload.toolName) ||
    (typeof payload.tool_name === "string" && payload.tool_name) ||
    (typeof payload.name === "string" && payload.name) ||
    ""
  const input =
    typeof payload.toolInput === "string"
      ? payload.toolInput
      : typeof payload.tool_input === "string"
        ? payload.tool_input
        : JSON.stringify(payload.toolInput ?? payload.tool_input ?? "")
  const output =
    typeof payload.toolOutput === "string"
      ? payload.toolOutput
      : typeof payload.tool_output === "string"
        ? payload.tool_output
        : typeof payload.output === "string"
          ? payload.output
          : ""
  return { toolName, toolInput: input, toolOutput: output }
}

function isSelfCapture(payload: Record<string, unknown>, text: string): boolean {
  const { toolName, toolInput } = extractToolBits(payload)
  return (
    SELF_CAPTURE_RE.test(toolName) ||
    SELF_CAPTURE_RE.test(toolInput) ||
    SELF_CAPTURE_RE.test(text)
  )
}

export type ObserveResult = {
  ok: true
  wrote: boolean
  candidateCount: number
  eventId?: string
}

export function observeCapture(opts: {
  host: CaptureHost
  eventType: string
  payload: Record<string, unknown>
  cwd?: string
}): ObserveResult {
  const repoRoot = resolveRepoRoot(opts.cwd)
  const promptRaw = extractPrompt(opts.payload)
  const { toolName, toolInput, toolOutput } = extractToolBits(opts.payload)
  const combined = [promptRaw, toolName, toolInput, toolOutput]
    .filter(Boolean)
    .join("\n")

  if (!combined.trim() || isSelfCapture(opts.payload, combined)) {
    return { ok: true, wrote: false, candidateCount: 0 }
  }

  const redactedPrompt = redactText(promptRaw)
  const redactedInput = redactText(toolInput)
  const redactedOutput = redactText(toolOutput)
  const classifySource = [redactedPrompt.text, redactedInput.text].join("\n")
  const classifications = classifyText(classifySource)
  if (classifications.length === 0) {
    return { ok: true, wrote: false, candidateCount: 0 }
  }

  const eventsDir = ensureEventsDir(repoRoot)
  const sessionId =
    (typeof opts.payload.sessionId === "string" && opts.payload.sessionId) ||
    (typeof opts.payload.session_id === "string" && opts.payload.session_id) ||
    "unknown"
  const eventId = randomUUID()
  const timestamp = new Date().toISOString()
  const files = filterFiles(opts.payload.files ?? opts.payload.file_paths)

  const event = {
    schemaVersion: 1,
    eventId,
    sessionId,
    sourceHost: opts.host,
    sourceEventType: opts.eventType,
    timestamp,
    toolName,
    promptExcerpt: redactedPrompt.text.slice(0, MAX_EXCERPT),
    toolInputSummary: redactedInput.text.slice(0, 400),
    toolOutputSummary: redactedOutput.text.slice(0, 400),
    files,
    redactionStatus:
      redactedPrompt.redacted || redactedInput.redacted || redactedOutput.redacted
        ? "redacted"
        : "clean",
    classifications,
  }

  const dayFile = join(eventsDir, "events", `${dayStamp()}.jsonl`)
  appendFileSync(dayFile, `${JSON.stringify(event)}\n`, "utf8")

  const candidatesPath = join(eventsDir, "candidates.jsonl")
  let candidateCount = 0
  for (const c of classifications) {
    const candidate = {
      schemaVersion: 1,
      candidateId: createHash("sha256")
        .update(`${eventId}:${c.kind}`)
        .digest("hex")
        .slice(0, 16),
      eventId,
      sessionId,
      kind: c.kind,
      destination: c.destination,
      action: c.action,
      excerpt: (redactedPrompt.text || redactedInput.text).slice(0, MAX_EXCERPT),
      files,
      createdAt: timestamp,
      sourceHost: opts.host,
    }
    appendFileSync(candidatesPath, `${JSON.stringify(candidate)}\n`, "utf8")
    candidateCount += 1
  }

  return { ok: true, wrote: true, candidateCount, eventId }
}

export type SummaryResult = {
  priority: "low" | "medium" | "high"
  message: string
  candidates: Array<{
    kind: string
    destination: string
    action: string
    excerpt: string
  }>
}

function readCandidates(repoRoot: string): Array<Record<string, unknown>> {
  const path = join(eventsRoot(repoRoot), "candidates.jsonl")
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>
      } catch {
        return null
      }
    })
    .filter((x): x is Record<string, unknown> => x !== null)
}

function readSummarized(repoRoot: string): Set<string> {
  const path = join(eventsRoot(repoRoot), "summarized.json")
  if (!existsSync(path)) return new Set()
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { ids?: string[] }
    return new Set(data.ids ?? [])
  } catch {
    return new Set()
  }
}

function writeSummarized(repoRoot: string, ids: string[]): void {
  ensureEventsDir(repoRoot)
  writeFileSync(
    join(eventsRoot(repoRoot), "summarized.json"),
    JSON.stringify({ ids, updatedAt: new Date().toISOString() }, null, 2),
    "utf8",
  )
}

export function summarizeCapture(opts: { cwd?: string } = {}): SummaryResult {
  const repoRoot = resolveRepoRoot(opts.cwd)
  const all = readCandidates(repoRoot)
  const done = readSummarized(repoRoot)
  const pending = all.filter((c) => {
    const id = typeof c.candidateId === "string" ? c.candidateId : ""
    return id && !done.has(id)
  })

  if (pending.length === 0) {
    return {
      priority: "low",
      message:
        "No new memory candidates. Continue; promote durable knowledge into .ai/memory when decisions land.",
      candidates: [],
    }
  }

  const listed = pending.slice(0, 8).map((c) => ({
    kind: String(c.kind ?? ""),
    destination: String(c.destination ?? ""),
    action: String(c.action ?? ""),
    excerpt: String(c.excerpt ?? "").slice(0, 220),
  }))

  const lines = [
    `Memory candidates (${pending.length} unsummarized). Promote via skills/rules — do not auto-write ADRs from hooks.`,
    ...listed.map(
      (c, i) =>
        `${i + 1}. [${c.kind}] → ${c.destination}: ${c.excerpt.replace(/\n/g, " ")}`,
    ),
    "Update the matching index.md when you add durable entries.",
  ]

  const ids = pending
    .map((c) => c.candidateId)
    .filter((id): id is string => typeof id === "string")
  writeSummarized(repoRoot, [...done, ...ids])

  return {
    priority: pending.length >= 3 ? "high" : "medium",
    message: lines.join("\n"),
    candidates: listed,
  }
}

export function readStdinJson(): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    process.stdin.on("data", (c) => chunks.push(Buffer.from(c)))
    process.stdin.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim()
      if (!raw) {
        resolvePromise({})
        return
      }
      try {
        resolvePromise(JSON.parse(raw) as Record<string, unknown>)
      } catch (err) {
        reject(err)
      }
    })
    process.stdin.on("error", reject)
  })
}

export function parseHost(value: string | undefined): CaptureHost {
  const v = (value ?? "unknown").toLowerCase()
  if (
    v === "cursor" ||
    v === "claude" ||
    v === "codex" ||
    v === "opencode" ||
    v === "vscode"
  ) {
    return v
  }
  return "unknown"
}

/** Resolve path under repo for tests */
export function resolveUnderRepo(repoRoot: string, ...parts: string[]): string {
  return pathResolve(repoRoot, ...parts)
}
