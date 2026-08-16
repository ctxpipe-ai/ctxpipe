/** One write-job kind per concern. Hydrate may enqueue several after a run. */
export const WORKSPACE_WRITE_JOB_KINDS = [
  "extract_ingest",
  "connector_mirror",
  "claims_upgrade",
  "rename_rewrite",
  "valid_from_persist",
  "semantic_merge",
  "ops_folder_map",
  "bootstrap",
  "link_unlink",
] as const

export type WorkspaceWriteJobKind = (typeof WORKSPACE_WRITE_JOB_KINDS)[number]

/** Cap retries of one kind against one SHA. Other kinds are unaffected. */
export const WRITE_JOB_RETRY_CAP_PER_SHA = 3

export const BOOTSTRAP_AGENTS_MD = "AGENTS.md"
export const BOOTSTRAP_KNOWLEDGE_SKILL_PREFIX =
  ".agents/skills/ctxpipe-knowledge/"

export function isWorkspaceWriteJobKind(
  value: string,
): value is WorkspaceWriteJobKind {
  return (WORKSPACE_WRITE_JOB_KINDS as readonly string[]).includes(value)
}

export function isBootstrapAllowedPath(path: string): boolean {
  const normalised = path.replace(/^\/+/, "")
  return (
    normalised === BOOTSTRAP_AGENTS_MD ||
    normalised.startsWith(BOOTSTRAP_KNOWLEDGE_SKILL_PREFIX)
  )
}

export function shouldEnqueueWorkspaceWriteJob(input: {
  writeStatus: string
  jobGeneration: number
  desiredGeneration: number
}):
  | { enqueue: true }
  | { enqueue: false; reason: "paused" | "stale_generation" } {
  if (input.jobGeneration !== input.desiredGeneration) {
    return { enqueue: false, reason: "stale_generation" }
  }
  if (input.writeStatus !== "writable") {
    return { enqueue: false, reason: "paused" }
  }
  return { enqueue: true }
}

/** Recheck immediately before push so a relink cannot write the old remote. */
export function shouldPushWorkspaceWriteJob(input: {
  writeStatus: string
  jobGeneration: number
  desiredGeneration: number
  jobWorkspaceUrl: string
  desiredWorkspaceUrl: string
}):
  | { push: true }
  | { push: false; reason: "paused" | "stale_generation" | "stale_url" } {
  const enqueue = shouldEnqueueWorkspaceWriteJob(input)
  if (!enqueue.enqueue) {
    return { push: false, reason: enqueue.reason }
  }
  if (input.jobWorkspaceUrl !== input.desiredWorkspaceUrl) {
    return { push: false, reason: "stale_url" }
  }
  return { push: true }
}

export function shouldRetryWriteJobKind(input: {
  attemptsForSha: number
  remainderBefore: number
  remainderAfter: number
  hydrateReportsWork: boolean
}): boolean {
  if (!input.hydrateReportsWork) return false
  if (input.remainderAfter >= input.remainderBefore) return false
  return input.attemptsForSha < WRITE_JOB_RETRY_CAP_PER_SHA
}

/** Template fallback when the LLM subject is empty, timed out, or garbage. */
export function fallbackCommitSubject(input: {
  repoName: string
  trigger?: string
}): string {
  const repo = input.repoName.replace(/\s+/g, " ").trim() || "workspace"
  const trigger = input.trigger?.replace(/\s+/g, " ").trim()
  const line = trigger
    ? `ctxpipe - Knowledge update of ${repo} from ${trigger}`
    : `ctxpipe - Knowledge update of ${repo}`
  return line.replace(/[\r\n]+/g, " ").slice(0, 200)
}
