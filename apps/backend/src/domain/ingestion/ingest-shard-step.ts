import { log } from "../../observability/logger.js"
import { RunVaultLostError } from "../workspaces/agent-vault.js"
import type { RootExec } from "./ingest-root.js"
import { ingestShardPreparedBundle } from "./ingest-shard-ops.js"

/*
 * The sandbox part of one ingest shard step. It decides if the step
 * prepares the sandbox first, and it keeps a plain git source host
 * (CTX-815) reachable only during that prepare.
 */

/** The sandbox of a step: its handle and its root commands. */
type ShardStepBox = { handle: { id: string }; root: RootExec }

/**
 * One step in the shard's sandbox. A new sandbox, or one whose prepare did
 * not finish, runs `prepare` first. Only during that prepare may the
 * sandbox reach a plain git source host: a step's agent never can (see
 * `ingestCredentialRules`). The source fetch rules end with the prepare,
 * also when it fails, before `run` starts an agent. A prepared sandbox with
 * another bundle (a deploy, CTX-1503) runs `refreshBundle`, with no source
 * fetch rules: an agent ran in it already. When a step fails, `stopAgents`
 * stops each agent process before the shard lock is released.
 *
 * When Agent Vault lost the sandbox's vault (a replaced Agent Vault task),
 * the sandbox holds a session and a CA of the old instance. The step then
 * destroys the sandbox and fails, and the step's next attempt makes a new
 * sandbox with a new vault, session and CA, and prepares it again.
 */
export async function withShardStep<T, B extends ShardStepBox>(input: {
  /** The root commands of the sandbox that exists already; null: none. */
  existingRoot: RootExec | null
  /** The bundle name of the step. */
  bundle: string
  /** True when the source is a plain git repository. */
  plainGitSource: boolean
  /** Set the Agent Vault rules of the sandbox again. */
  refresh: (fetchSource: boolean) => Promise<void>
  /** Destroy the sandbox and its vault. */
  destroy: () => Promise<void>
  /** Attach to the existing sandbox, or make one. */
  attach: () => Promise<B>
  prepare: (box: B) => Promise<void>
  /** Put the step's bundle in a prepared sandbox. */
  refreshBundle: (box: B) => Promise<void>
  run: (box: B) => Promise<T>
  stopAgents: (root: RootExec) => Promise<void>
  logContext: { orgId: string; runId: string }
}): Promise<T> {
  const refresh = async (fetchSource: boolean) => {
    try {
      await input.refresh(fetchSource)
    } catch (error) {
      if (error instanceof RunVaultLostError) {
        log.warn({
          step: "ingestion-v2.vault-lost",
          message:
            "Agent Vault lost the shard sandbox's vault; the next attempt makes a new sandbox",
          ...input.logContext,
        })
        await input.destroy()
      }
      throw error
    }
  }
  const preparedBundle = input.existingRoot
    ? await ingestShardPreparedBundle(input.existingRoot)
    : null
  const prepare = preparedBundle === null
  const fetchSource = prepare && input.plainGitSource
  // A new sandbox gets the source fetch rules at create; an existing one
  // gets this step's rules now.
  if (input.existingRoot) await refresh(fetchSource)
  const box = await input.attach()
  try {
    if (prepare) {
      try {
        await input.prepare(box)
      } finally {
        // The source fetch ends with the prepare, before an agent runs,
        // also when the prepare fails.
        if (fetchSource) await refresh(false)
      }
    } else if (preparedBundle !== input.bundle) await input.refreshBundle(box)
    return await input.run(box)
  } catch (error) {
    await input.stopAgents(box.root).catch((stopError: unknown) =>
      log.error({
        step: "ingest-shard-stop-agent",
        message: `Stopping the agent processes of a failed step failed: ${String(stopError)}`,
        ...input.logContext,
      }),
    )
    throw error
  }
}
