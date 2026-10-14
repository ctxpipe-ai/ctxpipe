import type { ArgRule, CallRule, EvalCase, Json } from "./cases.js"

/** One tool call of a run. `step` counts assistant messages, so parallel calls share a step. */
export type Call = {
  step: number
  tool: string
  args: Record<string, unknown>
  resultText: string
  isError: boolean
}

export type Transcript = { calls: Call[]; text: string }

export type CaseContext = {
  /** Seeded org slugs by fixture key, for example `{ harbor: "mcp-eval-run1-harbor" }`. */
  orgs: Record<string, string>
}

export type CaseOutcome = { passed: boolean; failures: string[] }

export const readToolNames = [
  "list_workspaces",
  "search_knowledge",
  "search_code",
  "find_symbol",
  "read_file",
  "list_files",
  "get_related",
] as const

/** Require exactly the seven public read tools. */
export function requireReadTools(names: readonly string[]): void {
  const missing = readToolNames.filter((name) => !names.includes(name))
  const unexpected = names.filter(
    (name) => !(readToolNames as readonly string[]).includes(name),
  )
  if (
    missing.length === 0 &&
    unexpected.length === 0 &&
    names.length === readToolNames.length
  )
    return
  throw new Error(
    `Unexpected tool set. Missing read tools: ${missing.join(", ") || "none"}. Unexpected tools: ${unexpected.join(", ") || "none"}. The server must offer exactly the seven read tools.`,
  )
}

/** Reduce a git URL or a handle to `owner/name`, in lower case. */
export function normalizeRepositoryRef(value: string): string {
  let text = value.trim().toLowerCase()
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
  text = text.replace(/^[^@/]+@/, "")
  text = text.replace(/^([^/:]+):(?!\/)/, "$1/")
  text = text.replace(/\/+$/, "").replace(/\.git$/, "")
  const parts = text.split("/").filter(Boolean)
  return parts.length >= 3 ? parts.slice(-2).join("/") : parts.join("/")
}

function resolveOrg(value: unknown, orgs: Record<string, string>): unknown {
  if (typeof value !== "string" || !value.startsWith("$")) return value
  const slug = orgs[value.slice(1)]
  if (!slug) throw new Error(`Unknown org placeholder ${value}`)
  return slug
}

/** Tool arguments with each `$org` placeholder replaced by the seeded slug. */
export function resolveOrgArgs(
  args: Record<string, Json>,
  orgs: Record<string, string>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([name, value]) => [
      name,
      resolveOrg(value, orgs),
    ]),
  )
}

/** The prompt of a case. A case with `cursorFrom` needs the real cursor. */
export function casePrompt(evalCase: EvalCase, cursor?: string): string {
  if (!evalCase.cursorFrom) return evalCase.prompt
  if (!cursor) throw new Error(`Case ${evalCase.id} needs a cursor`)
  return evalCase.prompt.replace("{cursor}", cursor)
}

function argMatches(
  rule: ArgRule,
  value: unknown,
  orgs: Record<string, string>,
): boolean {
  if ("equals" in rule) return value === resolveOrg(rule.equals, orgs)
  if ("startsWith" in rule)
    return typeof value === "string" && value.startsWith(rule.startsWith)
  if ("present" in rule) return value !== undefined && value !== null
  if ("includes" in rule)
    return Array.isArray(value) && value.includes(rule.includes)
  if ("emptyArray" in rule) return Array.isArray(value) && value.length === 0
  const wanted = normalizeRepositoryRef(rule.includesRepository)
  return (
    Array.isArray(value) &&
    value.some(
      (item) =>
        typeof item === "string" && normalizeRepositoryRef(item) === wanted,
    )
  )
}

function callMatches(
  rule: CallRule,
  call: Call,
  orgs: Record<string, string>,
): boolean {
  const tools = Array.isArray(rule.tool) ? rule.tool : [rule.tool]
  if (!tools.includes("*") && !tools.includes(call.tool)) return false
  return Object.entries(rule.args ?? {}).every(([name, arg]) =>
    argMatches(arg, call.args[name], orgs),
  )
}

const describeRule = (rule: CallRule) =>
  `${Array.isArray(rule.tool) ? rule.tool.join("|") : rule.tool} ${JSON.stringify(rule.args ?? {})}`

/** Judge one run of a case. Pure: the run adapter builds the transcript. */
export function checkCase(
  evalCase: EvalCase,
  transcript: Transcript,
  context: CaseContext,
): CaseOutcome {
  const failures: string[] = []
  const answer = transcript.text.toLowerCase()
  for (const fact of evalCase.facts ?? []) {
    if (!answer.includes(fact.toLowerCase()))
      failures.push(`answer lacks "${fact}"`)
  }
  for (const text of evalCase.notInAnswer ?? []) {
    if (answer.includes(text.toLowerCase()))
      failures.push(`answer contains "${text}"`)
  }
  const { calls } = transcript
  const { orgs } = context
  for (const rule of evalCase.calls ?? []) {
    const count = calls.filter((call) => callMatches(rule, call, orgs)).length
    if (count < (rule.min ?? 1))
      failures.push(
        `no call matches ${describeRule(rule)} (need ${rule.min ?? 1}, got ${count})`,
      )
  }
  for (const rule of evalCase.forbidden ?? []) {
    if (calls.some((call) => callMatches(rule, call, orgs)))
      failures.push(`forbidden call: ${describeRule(rule)}`)
  }
  for (const group of evalCase.parallel ?? []) {
    const wanted = new Map<string, number>()
    for (const tool of group) wanted.set(tool, (wanted.get(tool) ?? 0) + 1)
    const steps = new Set(calls.map((call) => call.step))
    const ok = [...steps].some((step) =>
      [...wanted].every(
        ([tool, count]) =>
          calls.filter((call) => call.step === step && call.tool === tool)
            .length >= count,
      ),
    )
    if (!ok) failures.push(`no single step calls ${group.join(" + ")}`)
  }
  // Argument quality for every call: a code tool must pass the exclusion list,
  // and it must name the working repository when the agent has one.
  const working = evalCase.workingRepository
  for (const call of calls) {
    if (call.tool !== "search_code" && call.tool !== "find_symbol") continue
    const excluded = call.args.excludeRepositories
    if (!Array.isArray(excluded)) {
      failures.push(`${call.tool} lacks excludeRepositories`)
    } else if (
      working &&
      !excluded.some(
        (item) =>
          typeof item === "string" &&
          normalizeRepositoryRef(item) === normalizeRepositoryRef(working),
      )
    ) {
      failures.push(`${call.tool} does not exclude the working repository`)
    }
  }
  const results = calls
    .map((call) => call.resultText)
    .join("\n")
    .toLowerCase()
  for (const text of evalCase.resultsMention ?? []) {
    if (!results.includes(text.toLowerCase()))
      failures.push(`no tool result mentions "${text}"`)
  }
  if (evalCase.recoversFromError) {
    const firstError = calls.findIndex((call) => call.isError)
    if (
      firstError >= 0 &&
      !calls.slice(firstError + 1).some((call) => !call.isError)
    )
      failures.push("no successful call after the failed call")
    if (!calls.some((call) => !call.isError))
      failures.push("no successful call")
  }
  return { passed: failures.length === 0, failures: [...new Set(failures)] }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      const record = asRecord(part)
      return record?.type === "text" && typeof record.text === "string"
        ? record.text
        : ""
    })
    .join("")
}

/**
 * Build a transcript from AI SDK model messages (the SDK's `getMessages()`).
 * Tool call parts carry `input` (AI SDK 5 and later) or `args`; tool result
 * parts carry `output` or `result`. The final answer is the text of the last
 * assistant message that has text.
 */
export function transcriptFromMessages(
  messages: readonly unknown[],
): Transcript {
  const calls: Call[] = []
  const byId = new Map<string, Call>()
  let step = 0
  let text = ""
  for (const message of messages) {
    const record = asRecord(message)
    if (!record) continue
    if (record.role === "assistant") {
      step += 1
      const answer = textOf(record.content)
      if (answer.trim()) text = answer
      if (!Array.isArray(record.content)) continue
      for (const part of record.content) {
        const item = asRecord(part)
        if (item?.type !== "tool-call" || typeof item.toolName !== "string")
          continue
        const call: Call = {
          step,
          tool: item.toolName,
          args: asRecord(item.input ?? item.args) ?? {},
          resultText: "",
          isError: false,
        }
        calls.push(call)
        if (typeof item.toolCallId === "string") byId.set(item.toolCallId, call)
      }
    } else if (record.role === "tool" && Array.isArray(record.content)) {
      for (const part of record.content) {
        const item = asRecord(part)
        if (item?.type !== "tool-result") continue
        const call =
          typeof item.toolCallId === "string"
            ? byId.get(item.toolCallId)
            : undefined
        if (!call) continue
        const output = item.output ?? item.result
        call.resultText =
          typeof output === "string" ? output : JSON.stringify(output)
        const wrapped = asRecord(output)
        const value = asRecord(wrapped?.value)
        call.isError =
          item.isError === true ||
          wrapped?.isError === true ||
          value?.isError === true ||
          (typeof wrapped?.type === "string" &&
            wrapped.type.startsWith("error"))
      }
    }
  }
  return { calls, text }
}
