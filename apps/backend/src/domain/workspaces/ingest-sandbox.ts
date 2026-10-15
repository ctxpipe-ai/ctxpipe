import { setTimeout as delay } from "node:timers/promises"
import {
  defineSandbox,
  type SandboxHandle,
  type SandboxProvider,
  type WorkspaceDefinition,
} from "@tanstack/ai-sandbox"
import { getSandboxInstance } from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"
import { scheduleConversationSandboxSweep } from "../../openworkflow/workflows/conversation-sandbox-sweep.js"
import {
  INGEST_SHARD_LIMIT_MS,
  ingestSandboxThreadId,
} from "./chat-lifecycle.js"
import {
  IngestSandboxSlotsFull,
  withIngestSandboxSlots,
} from "./conversation-sandbox-lifecycle.js"
import { postgresSandboxInstanceStore } from "./sandbox-instance-store.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"
import type { SandboxProvider as SandboxProviderName } from "./sandbox-provider.js"

/**
 * The sandbox of one ingest shard (ADR-052): the second stock definition
 * beside chat, `workspace-ingest:<image>`, on the chat store and locks.
 * `provider` is the ingest provider (T03) for the deployment's `isolation`.
 * Docker and Vercel sandboxes take the org's slots (at most 40 ingest of the
 * 50). An unsandboxed run, which only an operator can select, takes none.
 * Waiters have no order: a start takes the first slot it sees free. The
 * 60-minute shard limit bounds each wait.
 *
 * The sandbox is a cache: git holds each finished step. It has no idle stop.
 * It goes at `destroy()` after the run's last sandbox step, or at the org
 * sweep when its run has finished or the shard limit has passed.
 *
 * `workspaceId` is a Workspace of the run; the row is deleted with it.
 */
export function ingestSandbox(input: {
  orgId: string
  workspaceId: string
  runId: string
  shard: number
  isolation: SandboxProviderName
  provider: SandboxProvider
  image: string
  workspace?: WorkspaceDefinition
  signal?: AbortSignal
  /** How often a start at capacity looks for a free slot again. */
  slotPollMs?: number
}) {
  const threadId = ingestSandboxThreadId(input.runId, input.shard)
  const running = input.isolation === "unsandboxed" ? null : input.isolation
  const definition = defineSandbox({
    id: `workspace-ingest:${input.image}`,
    provider: running
      ? withIngestSandboxSlots(input.provider, {
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          threadId,
          runId: input.runId,
          provider: running,
          image: input.image,
        })
      : input.provider,
    workspace: input.workspace,
    lifecycle: { reuse: "thread", snapshot: "none", destroyOnComplete: false },
  })
  const abortController = new AbortController()
  if (input.signal?.aborted) abortController.abort(input.signal.reason)
  else
    input.signal?.addEventListener(
      "abort",
      () => abortController.abort(input.signal?.reason),
      { once: true },
    )
  if (!running)
    log.warn({
      step: "ingest-sandbox",
      message:
        "Ingest runs unsandboxed: it takes no sandbox slot and has no closed egress",
      orgId: input.orgId,
      runId: input.runId,
    })
  const ctx = {
    threadId,
    runId: input.runId,
    store: postgresSandboxInstanceStore({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      kind: "ingest",
      conversationId: threadId,
      image: input.image,
      provider: running ?? "local-process",
    }),
    locks: postgresSandboxLocks(
      input.orgId,
      abortController,
      `workspace-sandboxes:${input.workspaceId}`,
    ),
    signal: abortController.signal,
    tenant: { userId: undefined, orgId: input.orgId },
    adapterName: "opencode",
  }
  const key = definition.key(ctx)
  return {
    threadId,
    key,
    /**
     * Attach to the shard's sandbox, or create it. At capacity this waits
     * (outside every lock) until a slot is free or `signal` aborts. An
     * abort rejects with `signal.reason`, wherever the start was.
     */
    async ensure(): Promise<SandboxHandle> {
      for (;;) {
        try {
          const handle = await definition.ensure(ctx)
          await scheduleShardSweep(input.orgId, key)
          return handle
        } catch (error) {
          if (!(error instanceof IngestSandboxSlotsFull)) throw error
        }
        try {
          await delay(input.slotPollMs ?? 5_000, undefined, {
            signal: abortController.signal,
          })
        } catch (error) {
          // The wait ends with the signal's reason, as a start that the
          // signal ends does (`throwIfAborted`), not with Node's AbortError.
          abortController.signal.throwIfAborted()
          throw error
        }
      }
    },
    /** Attach to the shard's sandbox if it exists; never create one. */
    ensureExisting: () => definition.ensureExisting(ctx),
    /** Delete the shard's sandbox and its row. */
    destroy: () => definition.destroy(ctx),
  }
}

/**
 * The sweep deletes the sandbox at the shard limit, also when no later step
 * comes. A failed schedule is logged: the worker-start sweep is the backstop.
 */
async function scheduleShardSweep(orgId: string, key: string): Promise<void> {
  try {
    const row = await getSandboxInstance(key, orgId)
    if (!row) return
    const startedAt = (row.createdAt ?? row.lastHeartbeatAt).getTime()
    await scheduleConversationSandboxSweep(
      orgId,
      new Date(startedAt + INGEST_SHARD_LIMIT_MS),
    )
  } catch (error) {
    log.error({
      step: "ingest-sandbox-sweep-schedule",
      message: `Scheduling the ingest sandbox sweep failed: ${String(error)}`,
      orgId,
    })
  }
}
