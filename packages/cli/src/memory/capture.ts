import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join, resolve as pathResolve } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { resolveRepoRoot } from "./paths.js"

export { resolveRepoRoot } from "./paths.js"

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
      /\bfrom now on\b/i,
      /\bmake sure you\b/i,
      /\bstop doing\b/i,
      /\bnever\b.{0,80}\b(commit|use|do)\b/i,
      /\balways\b.{0,80}\b(use|prefer|pass|colocate)\b/i,
      /\bprefer\b.{0,80}\binstead of\b/i,
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

/** Broader durable-fact signals beyond strict decision/lesson phrasing. */
const FACT_PATTERNS: RegExp[] = [
  /\b(runs on|listens on|binds to)\s+(port\s+)?\d{2,5}\b/i,
  /\b(base url|endpoint|database|postgres|redis|falkordb)\b.+\b(is|are|uses|at)\b/i,
  /\b(the canonical|source of truth|must live in|belongs in)\b/i,
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
  [
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+@[^\s"'<>]+/gi,
    "[REDACTED_CONNECTION_STRING]",
  ],
]

const DENY_PATH_FRAGMENTS = [
  ".env",
  "credentials",
  "secrets",
  "keychain",
  "node_modules",
  ".git/",
]

const FOLLOWUP_PROMPT_RE =
  /Memory candidates \(|Promote via skills\/rules|mark ids promoted\/dismissed|do not auto-write ADRs from hooks/i

const SELF_CAPTURE_RE =
  /memory capture|memory-capture|capture\.ts|capture-adr|capture-lesson|capture-glossary|capture-decision|Memory candidates \(|Promote via skills\/rules|mark ids promoted\/dismissed|do not auto-write ADRs from hooks/i

const TOOL_DUMP_RE =
  /error TS\d+|Cannot find module|vitest run|FAIL\s+|^\s*✓\s+/m

const MEMORY_PATH_RE = /(?:^|[\\/])\.ai[\\/]memory(?:[\\/]|$)/i

const MAX_TEXT = 2000
const MAX_EXCERPT = 700

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
  if (hits.length === 0 && FACT_PATTERNS.some((p) => p.test(text))) {
    hits.push({
      kind: "lesson",
      destination: ".ai/memory/lessons-learned.md",
      action: "Append a durable fact/lesson with Rule / Category / Date / Source",
      confidence: "medium",
    })
  }
  return hits
}

function asString(value: unknown): string {
  if (typeof value === "string") return value
  if (value == null) return ""
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
}

function extractWorkspaceRoots(payload: Record<string, unknown>): string[] {
  const roots: string[] = []
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim()) roots.push(v.trim())
    else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string" && item.trim()) roots.push(item.trim())
      }
    }
  }
  add(payload.workspace_roots)
  add(payload.workspaceRoots)
  add(payload.workspaceRoot)
  add(payload.workspace_root)
  add(payload.cwd)
  add(payload.project_dir)
  add(payload.projectDir)
  add(payload.root)
  return roots
}

export function extractWorkspaceCwd(
  payload: Record<string, unknown>,
  filePath?: string,
): string | undefined {
  const roots = extractWorkspaceRoots(payload)
  if (filePath && roots.length > 0) {
    const match = roots
      .filter((r) => filePath === r || filePath.startsWith(r.endsWith("/") ? r : `${r}/`))
      .sort((a, b) => b.length - a.length)[0]
    if (match) return match
  }
  return roots[0]
}

function isDeniedPath(path: string): boolean {
  const lower = path.toLowerCase()
  return DENY_PATH_FRAGMENTS.some((frag) => lower.includes(frag))
}

function extractEdits(payload: Record<string, unknown>): {
  files: string[]
  editText: string
} {
  const files: string[] = []
  const chunks: string[] = []
  const filePath =
    (typeof payload.file_path === "string" && payload.file_path) ||
    (typeof payload.filePath === "string" && payload.filePath) ||
    ""
  if (filePath) files.push(filePath)
  const primaryDenied = Boolean(filePath && isDeniedPath(filePath))

  const edits = payload.edits
  if (Array.isArray(edits) && !primaryDenied) {
    for (const edit of edits.slice(0, 20)) {
      if (!edit || typeof edit !== "object") continue
      const e = edit as Record<string, unknown>
      const editPath =
        (typeof e.path === "string" && e.path) ||
        (typeof e.file_path === "string" && e.file_path) ||
        (typeof e.filePath === "string" && e.filePath) ||
        ""
      if (editPath && isDeniedPath(editPath)) continue
      // Prefer added/updated text; skip pure deletions (empty new_string).
      const newS = asString(e.new_string ?? e.newString)
      if (newS) chunks.push(newS)
    }
  }
  // Claude / generic path lists
  for (const key of ["paths", "files", "file_paths"]) {
    const v = payload[key]
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string") files.push(item)
        else if (item && typeof item === "object") {
          const p = (item as Record<string, unknown>).path
          if (typeof p === "string") files.push(p)
        }
      }
    }
  }
  return { files: filterFiles(files), editText: chunks.join("\n") }
}

function extractAssistant(payload: Record<string, unknown>): string {
  const keys = [
    "last_assistant_message",
    "lastAssistantMessage",
    "assistant_message",
    "assistantMessage",
    "response",
    "completion",
  ]
  for (const k of keys) {
    const v = payload[k]
    if (typeof v === "string" && v.trim()) return v
  }
  return ""
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
  const keys = [
    "prompt",
    "userPrompt",
    "user_prompt",
    "message",
    "text",
    "content",
    "transcript",
  ]
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

const DENIED_PATH_IN_TEXT_RE =
  /(?:^|[\s"'`=,:{[\\/])(?:[\w.-]+[\\/])*?(?:\.env(?:\.[A-Za-z0-9._-]*)?|credentials|secrets|keychain)(?:[\\/][\w.-]+)*/i

function textContainsDeniedPath(text: string): boolean {
  if (!text) return false
  if (isDeniedPath(text)) return true
  return DENIED_PATH_IN_TEXT_RE.test(text)
}

function collectPathHints(value: unknown, out: string[], depth = 0): void {
  if (depth > 5 || out.length >= 40) return
  if (typeof value === "string") {
    if (textContainsDeniedPath(value)) out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) collectPathHints(item, out, depth + 1)
    return
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (/path|file/i.test(key) && typeof nested === "string") out.push(nested)
      else collectPathHints(nested, out, depth + 1)
    }
  }
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
  const inputRaw = payload.toolInput ?? payload.tool_input ?? payload.input
  const outputRaw =
    payload.toolOutput ??
    payload.tool_output ??
    payload.output ??
    payload.result ??
    payload.tool_response
  const pathHints: string[] = []
  collectPathHints(inputRaw, pathHints)
  collectPathHints(outputRaw, pathHints)
  const input =
    typeof inputRaw === "string" ? inputRaw : inputRaw != null ? asString(inputRaw) : ""
  const output =
    typeof outputRaw === "string"
      ? outputRaw
      : outputRaw != null
        ? asString(outputRaw)
        : ""
  if (
    pathHints.some((p) => isDeniedPath(p) || textContainsDeniedPath(p)) ||
    textContainsDeniedPath(input) ||
    textContainsDeniedPath(output)
  ) {
    return { toolName, toolInput: "", toolOutput: "" }
  }
  return { toolName, toolInput: input, toolOutput: output }
}

function isSelfCapture(payload: Record<string, unknown>, text: string): boolean {
  const { toolName, toolInput } = extractToolBits(payload)
  const blob = `${toolName}\n${toolInput}\n${text}`
  return SELF_CAPTURE_RE.test(blob) || FOLLOWUP_PROMPT_RE.test(blob)
}

export function isUserPromptEvent(eventType: string): boolean {
  return /^(beforeSubmitPrompt|UserPromptSubmit)$/i.test(eventType.trim())
}

function isMemoryDurablePath(path: string): boolean {
  return MEMORY_PATH_RE.test(path.replace(/\\/g, "/"))
}

function isToolDumpNoise(
  toolName: string,
  toolInput: string,
  toolOutput: string,
): boolean {
  const blob = `${toolName}\n${toolInput}\n${toolOutput}`
  if (TOOL_DUMP_RE.test(blob)) return true
  if (
    /\b(rg|grep|ripgrep)\b/i.test(`${toolName} ${toolInput}`) &&
    MEMORY_PATH_RE.test(blob)
  ) {
    return true
  }
  if (
    /["']pattern["']\s*:/.test(toolInput) &&
    /lessons-learned|\.ai\/memory|SELF_CAPTURE|isSelfCapture/.test(toolInput)
  ) {
    return true
  }
  return false
}

function excerptDedupKey(kind: string, excerpt: string): string {
  return createHash("sha256")
    .update(`${kind}\n${excerpt.trim()}`)
    .digest("hex")
    .slice(0, 16)
}

function existingExcerptKeys(repoRoot: string): Set<string> {
  const keys = new Set<string>()
  const { candidates } = readCandidates(repoRoot)
  for (const c of candidates) {
    const kind = String(c.kind ?? "")
    const excerpt = String(c.excerpt ?? "")
    if (kind && excerpt) keys.add(excerptDedupKey(kind, excerpt))
  }
  return keys
}

export type ObserveResult = {
  ok: true
  wrote: boolean
  candidateCount: number
  eventId?: string
}

function pickMatchingExcerpt(parts: string[]): string {
  for (const part of parts) {
    if (part.trim() && classifyText(part).length > 0) return part
  }
  return parts.find((p) => p.trim()) ?? ""
}

export function observeCapture(opts: {
  host: CaptureHost
  eventType: string
  payload: Record<string, unknown>
  cwd?: string
}): ObserveResult {
  const promptRaw = isUserPromptEvent(opts.eventType)
    ? extractPrompt(opts.payload)
    : ""
  const { toolName, toolInput, toolOutput } = extractToolBits(opts.payload)
  const assistantRaw = extractAssistant(opts.payload)
  const { files: editFiles, editText } = extractEdits(opts.payload)
  const payloadCwd = extractWorkspaceCwd(opts.payload, editFiles[0])
  const repoRoot = resolveRepoRoot(opts.cwd ?? payloadCwd ?? process.cwd())
  const files = filterFiles([
    ...editFiles,
    ...(Array.isArray(opts.payload.files) ? opts.payload.files : []),
    ...(Array.isArray(opts.payload.file_paths) ? opts.payload.file_paths : []),
  ])

  if (
    FOLLOWUP_PROMPT_RE.test(promptRaw) ||
    FOLLOWUP_PROMPT_RE.test(assistantRaw)
  ) {
    return { ok: true, wrote: false, candidateCount: 0 }
  }

  if (
    files.some(isMemoryDurablePath) ||
    editFiles.some(isMemoryDurablePath)
  ) {
    return { ok: true, wrote: false, candidateCount: 0 }
  }

  if (isToolDumpNoise(toolName, toolInput, toolOutput)) {
    return { ok: true, wrote: false, candidateCount: 0 }
  }

  const selfText = [promptRaw, assistantRaw, toolName, toolInput].join("\n")
  if (!selfText.trim() || isSelfCapture(opts.payload, selfText)) {
    return { ok: true, wrote: false, candidateCount: 0 }
  }

  const redactedPrompt = redactText(promptRaw)
  const redactedInput = redactText(toolInput)
  const redactedOutput = redactText(toolOutput)
  const redactedAssistant = redactText(assistantRaw)
  const redactedEdits = redactText(editText)
  // Tool dumps and file edits may be logged, but only prompt/assistant mint candidates.
  const classifySource = [redactedPrompt.text, redactedAssistant.text]
    .filter((t) => t.trim())
    .join("\n")
  if (!classifySource.trim()) {
    return { ok: true, wrote: false, candidateCount: 0 }
  }
  const classifications = classifyText(classifySource)
  if (classifications.length === 0) {
    return { ok: true, wrote: false, candidateCount: 0 }
  }

  const excerpt = pickMatchingExcerpt([
    redactedAssistant.text,
    redactedPrompt.text,
  ]).slice(0, MAX_EXCERPT)
  const seen = existingExcerptKeys(repoRoot)
  const unique = classifications.filter((c) => {
    const key = excerptDedupKey(c.kind, excerpt)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (unique.length === 0) {
    return { ok: true, wrote: false, candidateCount: 0 }
  }

  const eventsDir = ensureEventsDir(repoRoot)
  const sessionId =
    (typeof opts.payload.sessionId === "string" && opts.payload.sessionId) ||
    (typeof opts.payload.session_id === "string" && opts.payload.session_id) ||
    "unknown"
  const eventId = randomUUID()
  const timestamp = new Date().toISOString()

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
    assistantExcerpt: redactedAssistant.text.slice(0, 400),
    editExcerpt: redactedEdits.text.slice(0, 400),
    files,
    redactionStatus:
      redactedPrompt.redacted ||
      redactedInput.redacted ||
      redactedOutput.redacted ||
      redactedAssistant.redacted ||
      redactedEdits.redacted
        ? "redacted"
        : "clean",
    classifications: unique,
  }

  const dayFile = join(eventsDir, "events", `${dayStamp()}.jsonl`)
  appendFileSync(dayFile, `${JSON.stringify(event)}\n`, "utf8")

  const candidatesPath = join(eventsDir, "candidates.jsonl")
  let candidateCount = 0
  for (const c of unique) {
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
      excerpt,
      files,
      createdAt: timestamp,
      sourceHost: opts.host,
      sourceEventType: opts.eventType,
    }
    appendFileSync(candidatesPath, `${JSON.stringify(candidate)}\n`, "utf8")
    candidateCount += 1
  }

  return { ok: true, wrote: true, candidateCount, eventId }
}

export type SummaryCandidate = {
  candidateId: string
  kind: string
  destination: string
  action: string
  excerpt: string
}

export type SummaryResult = {
  priority: "low" | "medium" | "high"
  message: string
  candidates: SummaryCandidate[]
  /** IDs listed in this summary; call acknowledgeSurfaced after successful delivery. */
  surfacedIds: string[]
  parseErrors: number
}

/** Host-specific Stop/summary stdout. Empty object = allow stop / no follow-up. */
export function formatStopHookOutput(
  host: CaptureHost,
  result: SummaryResult,
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  const stopActive =
    payload.stop_hook_active === true || payload.stopHookActive === true
  const cursorStatus =
    typeof payload.status === "string" ? payload.status.toLowerCase() : ""
  // Cursor ignores follow-ups on aborted/error stops — do not emit or ack.
  if (
    host === "cursor" &&
    (cursorStatus === "aborted" || cursorStatus === "error")
  ) {
    return {}
  }
  if (stopActive || result.priority === "low" || !result.message.trim()) {
    return {}
  }
  if (host === "claude") {
    // Claude: additionalContext continues the turn without a hook-error UX.
    return {
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: result.message,
      },
    }
  }
  if (host === "codex") {
    // Codex Stop continuation contract.
    return {
      decision: "block",
      reason: result.message,
    }
  }
  // Cursor (+ hosts that understand Cursor followup_message)
  return {
    followup_message: result.message,
    priority: result.priority,
    message: result.message,
    candidates: result.candidates,
  }
}

function readCandidates(repoRoot: string): {
  candidates: Array<Record<string, unknown>>
  parseErrors: number
} {
  const path = join(eventsRoot(repoRoot), "candidates.jsonl")
  if (!existsSync(path)) return { candidates: [], parseErrors: 0 }
  let parseErrors = 0
  const candidates = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>
      } catch {
        parseErrors += 1
        return null
      }
    })
    .filter((x): x is Record<string, unknown> => x !== null)
  return { candidates, parseErrors }
}

const SUMMARY_BATCH = 8

type CandidateLifecycleState = {
  /** IDs printed in a summary at least once (pending → surfaced). */
  surfaced: string[]
  /** IDs agent marked promoted into durable Markdown. */
  promoted: string[]
  /** IDs agent dismissed without promoting. */
  dismissed: string[]
  updatedAt?: string
}

function lifecyclePath(repoRoot: string): string {
  return join(eventsRoot(repoRoot), "lifecycle.json")
}

/**
 * Read pending→surfaced→promoted|dismissed lifecycle.
 * Legacy summarized.json marked *all* pending IDs (including never printed);
 * ignore it so those candidates can surface again under the new batching rules.
 */
function readLifecycle(repoRoot: string): CandidateLifecycleState {
  const path = lifecyclePath(repoRoot)
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as Partial<CandidateLifecycleState>
      return {
        surfaced: Array.isArray(data.surfaced) ? data.surfaced : [],
        promoted: Array.isArray(data.promoted) ? data.promoted : [],
        dismissed: Array.isArray(data.dismissed) ? data.dismissed : [],
        updatedAt: data.updatedAt,
      }
    } catch {
      // fall through
    }
  }
  return { surfaced: [], promoted: [], dismissed: [] }
}

function writeLifecycle(repoRoot: string, state: CandidateLifecycleState): void {
  ensureEventsDir(repoRoot)
  writeFileSync(
    lifecyclePath(repoRoot),
    JSON.stringify(
      { ...state, updatedAt: new Date().toISOString() },
      null,
      2,
    ),
    "utf8",
  )
}

/** Terminal states only — surfaced stays visible until promote/dismiss. */
function closedIds(state: CandidateLifecycleState): Set<string> {
  return new Set([...state.promoted, ...state.dismissed])
}

/**
 * Persist pending→surfaced only after the host successfully received the summary.
 * Call this after stdout write succeeds — never before.
 */
export function acknowledgeSurfaced(
  ids: string[],
  opts: { cwd?: string } = {},
): void {
  if (ids.length === 0) return
  const repoRoot = resolveRepoRoot(opts.cwd)
  const lifecycle = readLifecycle(repoRoot)
  writeLifecycle(repoRoot, {
    ...lifecycle,
    surfaced: [...new Set([...lifecycle.surfaced, ...ids])],
  })
}

/** Mark candidates promoted into durable Markdown (surfaced → promoted). */
export function markPromoted(ids: string[], opts: { cwd?: string } = {}): void {
  if (ids.length === 0) return
  const repoRoot = resolveRepoRoot(opts.cwd)
  const lifecycle = readLifecycle(repoRoot)
  const promoted = new Set([...lifecycle.promoted, ...ids])
  writeLifecycle(repoRoot, {
    ...lifecycle,
    surfaced: lifecycle.surfaced.filter((id) => !promoted.has(id)),
    promoted: [...promoted],
    dismissed: lifecycle.dismissed.filter((id) => !promoted.has(id)),
  })
}

/** Mark candidates dismissed without promoting (surfaced → dismissed). */
export function markDismissed(ids: string[], opts: { cwd?: string } = {}): void {
  if (ids.length === 0) return
  const repoRoot = resolveRepoRoot(opts.cwd)
  const lifecycle = readLifecycle(repoRoot)
  const dismissed = new Set([...lifecycle.dismissed, ...ids])
  writeLifecycle(repoRoot, {
    ...lifecycle,
    surfaced: lifecycle.surfaced.filter((id) => !dismissed.has(id)),
    promoted: lifecycle.promoted.filter((id) => !dismissed.has(id)),
    dismissed: [...dismissed],
  })
}

/**
 * Build a summary of pending candidates (batch of SUMMARY_BATCH).
 * Does **not** advance lifecycle — caller must acknowledgeSurfaced after delivery.
 *
 * Cursor Stop injects `followup_message` as a new user turn, so only never-shown
 * user-prompt candidates get a follow-up. Tool/edit-sourced items wait for the
 * next real user prompt. Claude/Codex may re-show unresolved surfaced ids.
 */
export function summarizeCapture(
  opts: { cwd?: string; host?: CaptureHost } = {},
): SummaryResult {
  const host = opts.host ?? "cursor"
  const repoRoot = resolveRepoRoot(opts.cwd)
  const { candidates: all, parseErrors } = readCandidates(repoRoot)
  const lifecycle = readLifecycle(repoRoot)
  const closed = closedIds(lifecycle)
  const surfaced = new Set(lifecycle.surfaced)
  const pending = all.filter((c) => {
    const id = typeof c.candidateId === "string" ? c.candidateId : ""
    return id && !closed.has(id)
  })

  const parseNote =
    parseErrors > 0
      ? ` Warning: ${parseErrors} malformed candidate line(s) in candidates.jsonl were skipped.`
      : ""

  if (pending.length === 0) {
    return {
      priority: "low",
      message:
        `No new memory candidates. Continue; promote durable knowledge into .ai/memory when decisions land.${parseNote}`,
      candidates: [],
      surfacedIds: [],
      parseErrors,
    }
  }

  const neverShown = pending.filter(
    (c) => !surfaced.has(String(c.candidateId ?? "")),
  )
  const previouslyShown = pending.filter((c) =>
    surfaced.has(String(c.candidateId ?? "")),
  )

  const cursorFollowUp =
    host === "cursor"
      ? neverShown.filter((c) =>
          isUserPromptEvent(String(c.sourceEventType ?? "")),
        )
      : []

  if (host === "cursor" && cursorFollowUp.length === 0) {
    return {
      priority: "low",
      message: `${pending.length} memory candidate(s) pending (already shown or not from a user prompt). Not injecting a turn.${parseNote}`,
      candidates: [],
      surfacedIds: [],
      parseErrors,
    }
  }

  const pool =
    host === "cursor"
      ? cursorFollowUp
      : [...neverShown, ...previouslyShown]
  const batch = pool.slice(0, SUMMARY_BATCH)
  const listed: SummaryCandidate[] = batch.map((c) => ({
    candidateId: String(c.candidateId ?? ""),
    kind: String(c.kind ?? ""),
    destination: String(c.destination ?? ""),
    action: String(c.action ?? ""),
    excerpt: String(c.excerpt ?? "").slice(0, 220),
  }))

  const remaining = pool.length - batch.length
  const lines = [
    `Memory candidates (${pool.length} pending${remaining > 0 ? `, showing ${batch.length}` : ""}). Promote via skills/rules — do not auto-write ADRs from hooks.`,
    ...listed.map(
      (c, i) =>
        `${i + 1}. [${c.kind}] ${c.candidateId} → ${c.destination}: ${c.excerpt.replace(/\n/g, " ")}`,
    ),
    ...(remaining > 0
      ? [`${remaining} more pending — will surface on the next summary.`]
      : []),
    "Update the matching index.md when you add durable entries. Then mark ids promoted/dismissed.",
    ...(parseErrors > 0
      ? [`Warning: skipped ${parseErrors} malformed candidates.jsonl line(s).`]
      : []),
  ]

  const surfacedIds = listed
    .map((c) => c.candidateId)
    .filter((id) => id.length > 0)

  return {
    priority: pool.length >= 3 ? "high" : "medium",
    message: lines.join("\n"),
    candidates: listed,
    surfacedIds,
    parseErrors,
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
