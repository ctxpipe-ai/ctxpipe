import { randomUUID } from "node:crypto"

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
 * for 50 minutes after its mint, so a token in use has at least 10 minutes
 * left. The `<window>` of the key is the 50-minute clock window of the mint.
 * It makes parallel mints of one label meet at one key. It does not limit
 * the reuse: a token minted just before a window boundary stays in use after
 * the boundary.
 */
const REUSE_MS = 50 * 60_000
// The key bucket equals the reuse age, so a young token is in one of two keys.
const WINDOW_MS = REUSE_MS
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
 * The owner's recorded token for `label` that is younger than 50 minutes, or
 * a new uncached token from `mint`, recorded before it is returned.
 */
export async function recordedRunGitToken(
  input: RunTokenOptions &
    RunTokenOwner & {
      label: string
      mint: () => Promise<string | undefined>
    },
): Promise<string | undefined> {
  const store = storeFor(input)
  const prefix = `${keyBase(input)}${input.label}:`
  const now = Date.now()
  // The key window comes from `now`, before the mint. `mintedAt` is set after
  // the mint, so a young token can be one window older than its age suggests:
  // it is in the key of one of the last three windows.
  const bucket = Math.floor(now / WINDOW_MS)
  let recorded: { token: string } | undefined
  for (const candidate of [bucket, bucket - 1, bucket - 2]) {
    const row = await store.get(`${prefix}${candidate}`)
    if (row && now - row.mintedAt.getTime() < REUSE_MS) {
      recorded = row
      break
    }
  }
  if (recorded) return recorded.token
  const key = `${prefix}${bucket}`
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
 * The GitHub token of one Workspace base build, recorded like a run token
 * under `run:workspace-base-<workspace>:clone:<build>:<window>`. `revoke`
 * revokes it at the end of the build. When the build process stops before
 * that, the sandbox sweep revokes it.
 */
export function recordedBaseBuildGitToken(
  input: RunTokenOptions & {
    workspaceId: string
    mint: () => Promise<string>
  },
): { mint: () => Promise<string>; revoke: () => Promise<void> } {
  const conversationId = `workspace-base-${input.workspaceId}`
  const label = `clone:${randomUUID()}`
  return {
    mint: async () => {
      const token = await recordedRunGitToken({
        ...input,
        conversationId,
        label,
      })
      if (!token)
        throw new Error("The Workspace base build got no GitHub token")
      return token
    },
    revoke: async () => {
      const left = await revokeRunGitTokens({
        ...input,
        conversationId,
        prefixes: [`${label}:`],
      })
      if (left > 0)
        throw new Error("The sweep revokes the base build's GitHub token later")
    },
  }
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
