/**
 * The class of a failed upgrade, for the failure card (CTX-895). The card
 * maps each code to a reason in plain words and one action, so a failure is
 * never a dead end. The upgrade and ingestion code writes fixed host
 * sentences, so the class comes from that text.
 */
export const UPGRADE_FAILURE_CODES = [
  "source_access",
  "workspace_write_access",
  "cost_cap",
  "sandbox",
  "model",
  "publish_conflict",
  "timeout",
  "too_many_sources",
  "unknown",
] as const

export type UpgradeFailureCode = (typeof UPGRADE_FAILURE_CODES)[number]

/** The step that failed. `null`: ctx| cannot tell. */
export const UPGRADE_FAILURE_STEPS = [
  "plan",
  "wait",
  "read_source",
  "ingest",
  "publish",
] as const

export type UpgradeFailureStep = (typeof UPGRADE_FAILURE_STEPS)[number]

export type UpgradeFailure = {
  code: UpgradeFailureCode
  step: UpgradeFailureStep | null
  /** The source repository of the failed step, when one failed. */
  repository: string | null
  /** The cause as ctx| recorded it: one line, with no credential and no stack trace. */
  summary: string
}

const RULES: Array<{
  code: UpgradeFailureCode
  step: UpgradeFailureStep | null
  match: RegExp
}> = [
  { code: "cost_cap", step: "ingest", match: /cost cap/ },
  {
    code: "too_many_sources",
    step: "plan",
    match: /one re-ingestion run handles at most/,
  },
  {
    code: "source_access",
    step: "read_source",
    match:
      /cannot read the default branch|repository not found|authentication failed|could not read username|permission to .* denied/,
  },
  {
    code: "workspace_write_access",
    step: "publish",
    match:
      /not writable|write access|contents write|resource not accessible by integration|requires a connected github repository/,
  },
  { code: "sandbox", step: "ingest", match: /sandbox/ },
  {
    code: "publish_conflict",
    step: "publish",
    match:
      /semantic merge|default branch kept changing|binding changed|did not publish to this workspace/,
  },
  {
    code: "model",
    step: "ingest",
    match: /\bmodel\b|provider|rate limit|structured output|overloaded|\b429\b/,
  },
  { code: "timeout", step: "wait", match: /waited too long for its turn/ },
  {
    code: "timeout",
    step: "ingest",
    match: /did not finish in the time/,
  },
]

/**
 * One short line of `text`: its first line, with no stack frame, no
 * credential in a URL, and no token, at most 240 characters.
 */
export function safeFailureSummary(text: string): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("at ")) ?? ""
  const clean = line
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, "[token]")
    .replace(/\b(token|key|secret|password)=\S+/gi, "$1=[hidden]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [hidden]")
  return clean.length > 240 ? `${clean.slice(0, 239)}…` : clean
}

/** The class of a failed upgrade row. Null when the row did not fail. */
export function classifyUpgradeFailure(input: {
  status: string
  failureReason: string | null
  stopReason?: string | undefined
  repositories?: ReadonlyArray<{
    repository: string
    status: string
    report: readonly string[]
  }>
}): UpgradeFailure | null {
  if (input.status !== "failed") return null
  const failed = (input.repositories ?? []).find(
    (r) => r.status !== "done" && r.status !== "pending" && r.report.length,
  )
  const cause = failed?.report.join("\n") ?? input.failureReason ?? ""
  const text = `${cause}\n${input.failureReason ?? ""}`.toLowerCase()
  const rule =
    input.stopReason === "cost_cap"
      ? RULES[0]
      : RULES.find((r) => r.match.test(text))
  return {
    code: rule?.code ?? "unknown",
    step: rule?.step ?? (failed ? "ingest" : null),
    repository: failed?.repository ?? null,
    // The card gives the fix, so the summary does not repeat it.
    summary:
      safeFailureSummary(cause).replace(/\s*Start it again\.$/, "") ||
      "ctx| recorded no reason.",
  }
}
