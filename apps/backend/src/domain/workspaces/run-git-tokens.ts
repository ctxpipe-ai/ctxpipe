import { parseEnv } from "../../config/env.js"
import {
  type RunGitTokenStore,
  sandboxGitTokenStore,
} from "../../models/sandbox-git-tokens.js"
import { unfinishedOrgWorkflowRunIds } from "../../models/workspace-sandboxes.js"
import { log } from "../../observability/logger.js"
import { INGESTION_V2_WORKFLOW_NAME } from "../ingestion/ingestion-run.js"
import { revokeGithubToken } from "./clone-credentials.js"
import { withSandboxLockIfFree } from "./sandbox-lock-store.js"

/**
 * Run tokens: the GitHub read tokens of Docker and local runs (a Docker
 * run's token is in its Agent Vault vault, a local run's clone token is in
 * its environment). Each is recorded under `run:<conversation>:<label>:<window>` and revoked when the
 * turn ends. The conversation sandbox sweep revokes what a turn end could not.
 *
 * An ingest shard (ADR-052) records its tokens under its thread,
 * `ingest:<run>:<shard>:<label>:<window>`. `destroy` of the shard's sandbox
 * revokes them; the sweep revokes those of finished runs.
 *
 * GitHub installation tokens are valid for 60 minutes. A token is used only
 * in the 50-minute window it was minted in, so a token in use has at least
 * 10 minutes left.
 */
const WINDOW_MS = 50 * 60_000
const TOKEN_LIFETIME_MS = 60 * 60_000
const SWEEP_MIN_AGE_MS = 2 * 60_000

type RunTokenOptions = {
  orgId: string
  /** Defaults to the org's store. */
  store?: RunGitTokenStore
  /** Defaults to GitHub's revoke endpoint. */
  revoke?: (token: string) => Promise<void>
}

/** Whose tokens: a conversation's, or an ingest shard's (its thread id). */
type RunTokenOwner = { conversationId: string } | { ingestThreadId: string }

const keyBase = (owner: RunTokenOwner) =>
  "ingestThreadId" in owner
    ? `${owner.ingestThreadId}:`
    : `run:${owner.conversationId}:`

const storeFor = (input: RunTokenOptions) =>
  input.store ??
  sandboxGitTokenStore(
    input.orgId,
    parseEnv(process.env as Record<string, string | undefined>),
  )

/**
 * The conversation's recorded token for `label` in the current window, or a
 * new uncached token from `mint`, recorded before it is returned.
 */
export async function recordedRunGitToken(
  input: RunTokenOptions &
    RunTokenOwner & {
      label: string
      mint: () => Promise<string | undefined>
    },
): Promise<string | undefined> {
  const store = storeFor(input)
  const key = `${keyBase(input)}${input.label}:${Math.floor(Date.now() / WINDOW_MS)}`
  const recorded = await store.get(key)
  if (recorded) return recorded.token
  const minted = await input.mint()
  if (!minted) return undefined
  if (await store.add(key, minted)) return minted
  // A parallel request recorded its token first: use that one.
  await (input.revoke ?? revokeGithubToken)(minted).catch((error: unknown) =>
    log.warn({
      step: "workspace-chat-run-token-revoke",
      message: `Revoking an unused run GitHub token failed: ${String(error)}`,
      tokenOwner: keyBase(input),
    }),
  )
  return (await store.get(key))?.token
}

/**
 * Revoke the conversation's run tokens, or only those whose labels start
 * with one of `prefixes` (one turn's tokens). `minAgeMs` leaves younger
 * tokens (counted as left). A record is removed only after
 * GitHub confirms, so the sweep retries a failed revoke. Never throws: the
 * count of tokens left is returned.
 */
export async function revokeRunGitTokens(
  input: RunTokenOptions &
    RunTokenOwner & {
      prefixes?: string[]
      minAgeMs?: number
    },
): Promise<number> {
  const store = storeFor(input)
  const base = keyBase(input)
  let left = 0
  try {
    const rows = (
      await Promise.all(
        (input.prefixes ?? [""]).map((prefix) => store.list(base + prefix)),
      )
    ).flat()
    for (const row of rows) {
      if (Date.now() - row.mintedAt.getTime() < (input.minAgeMs ?? 0)) {
        left += 1
        continue
      }
      try {
        if (Date.now() - row.mintedAt.getTime() < TOKEN_LIFETIME_MS)
          await (input.revoke ?? revokeGithubToken)(row.token)
        await store.take(row.key)
      } catch (error) {
        left += 1
        log.warn({
          step: "workspace-chat-run-token-revoke",
          message: `Revoking a run GitHub token failed: ${String(error)}`,
          tokenOwner: base,
        })
      }
    }
  } catch (error) {
    left += 1
    log.warn({
      step: "workspace-chat-run-token-revoke",
      message: `Reading the run GitHub tokens failed: ${String(error)}`,
      tokenOwner: base,
    })
  }
  return left
}

/**
 * The sweep's backstop: revoke the run tokens, older than 2 minutes, of
 * every conversation that no turn or file read holds. Returns true when a
 * token is left for a later sweep (a failed revoke, a young token, or a held
 * conversation).
 */
export async function revokeIdleRunGitTokens(
  input: RunTokenOptions,
): Promise<boolean> {
  const store = storeFor(input)
  const conversations = new Set(
    (await store.list("run:")).map((row) => row.key.split(":")[1] ?? ""),
  )
  let pending = false
  for (const conversationId of conversations) {
    const outcome = await withSandboxLockIfFree(
      input.orgId,
      `chat-thread:${conversationId}`,
      // A turn mints its clone token before it takes the lock; a young
      // token may belong to a turn that is about to start.
      () =>
        revokeRunGitTokens({
          ...input,
          store,
          conversationId,
          minAgeMs: SWEEP_MIN_AGE_MS,
        }),
    )
    if (outcome.busy || outcome.value > 0) pending = true
  }
  return pending
}

/**
 * The sweep's backstop for ingest shards: revoke the tokens of each shard
 * whose ingestion run is finished or unknown (a `destroy` that did not run).
 * Returns true when a token is left for a later sweep.
 */
export async function revokeFinishedIngestGitTokens(
  input: RunTokenOptions,
): Promise<boolean> {
  const store = storeFor(input)
  // `ingest:<run>:<shard>:<label>:<window>`
  const threads = new Map<string, string>()
  for (const row of await store.list("ingest:")) {
    const [, runId, shard] = row.key.split(":")
    if (runId && shard) threads.set(`ingest:${runId}:${shard}`, runId)
  }
  if (threads.size === 0) return false
  const unfinished = await unfinishedOrgWorkflowRunIds(
    input.orgId,
    INGESTION_V2_WORKFLOW_NAME,
    [...new Set(threads.values())],
  )
  let pending = false
  for (const [ingestThreadId, runId] of threads) {
    if (unfinished.has(runId)) continue
    if ((await revokeRunGitTokens({ ...input, store, ingestThreadId })) > 0)
      pending = true
  }
  return pending
}
