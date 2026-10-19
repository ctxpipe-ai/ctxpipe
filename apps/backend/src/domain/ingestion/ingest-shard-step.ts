import { log } from "../../observability/logger.js"
import type {
  ConversationFirewall,
  HostedTurnCredentials,
} from "../workspaces/vercel-sandbox-provider.js"
import type { RootExec } from "./ingest-root.js"
import { ingestShardPrepared } from "./ingest-shard-ops.js"

/*
 * The sandbox part of one ingest shard step, for each provider. It decides
 * if the step prepares the sandbox first, and it keeps a plain git source
 * host (CTX-815) reachable only during that prepare.
 */

/**
 * Run `fn` with the step's credentials in the hosted sandbox firewall (no
 * firewall: Docker, just `fn`). `closeTurn` always runs, also when
 * `openTurn` throws: Vercel can apply an update and still answer with an
 * error, so the step's credentials can be in the policy then. A failed
 * `closeTurn` is logged: the capability ends with the lock owner, and the
 * scope expires.
 */
export async function withStepFirewall<T>(
  firewall: ConversationFirewall | undefined,
  sandboxName: string,
  credentials: HostedTurnCredentials,
  logContext: { orgId: string; runId: string },
  fn: () => Promise<T>,
): Promise<T> {
  if (!firewall) return fn()
  try {
    await firewall.openTurn(sandboxName, credentials)
    return await fn()
  } finally {
    await firewall.closeTurn(sandboxName).catch((error: unknown) =>
      log.error({
        step: "ingest-shard-close-turn",
        message: `Removing the step's credentials from the sandbox firewall failed: ${String(error)}`,
        ...logContext,
      }),
    )
  }
}

/** The sandbox of a step: its handle and its root commands. */
type ShardStepBox = { handle: { id: string }; root: RootExec }

/**
 * One step in the shard's sandbox. A new sandbox, or one whose prepare did
 * not finish, runs `prepare` first. Only during that prepare may the
 * sandbox reach a plain git source host: a step's agent never can (see
 * `ingestCredentialRules`). The source fetch rules end with the prepare,
 * also when it fails, before `run` starts an agent. When a step fails,
 * `stopAgents` stops each agent process before the shard lock is released.
 */
export async function withShardStep<T, B extends ShardStepBox>(input: {
  /** The root commands of the sandbox that exists already; null: none. */
  existingRoot: RootExec | null
  /** True when the source is a plain git repository. */
  plainGitSource: boolean
  /** Hosted: the firewall that holds the step's credentials. */
  firewall: ConversationFirewall | undefined
  credentials: HostedTurnCredentials
  /** Docker: set the Agent Vault rules of the sandbox again. */
  refresh: (fetchSource: boolean) => Promise<void>
  /** Attach to the existing sandbox, or make one. */
  attach: () => Promise<B>
  prepare: (box: B) => Promise<void>
  run: (box: B) => Promise<T>
  stopAgents: (root: RootExec) => Promise<void>
  logContext: { orgId: string; runId: string }
}): Promise<T> {
  const prepare =
    !input.existingRoot || !(await ingestShardPrepared(input.existingRoot))
  const fetchSource = prepare && input.plainGitSource
  // Docker: a new sandbox gets the source fetch rules at create; an
  // existing one gets this step's rules now. Vercel: the firewall gets
  // them below.
  if (input.existingRoot && !input.firewall) await input.refresh(fetchSource)
  const box = await input.attach()
  return withStepFirewall(
    input.firewall,
    box.handle.id,
    fetchSource
      ? { ...input.credentials, fetchSource: true }
      : input.credentials,
    input.logContext,
    async () => {
      try {
        if (prepare) {
          try {
            await input.prepare(box)
          } finally {
            // The source fetch ends with the prepare, before an agent runs,
            // also when the prepare fails.
            if (fetchSource && input.firewall)
              await input.firewall.openTurn(box.handle.id, input.credentials)
            else if (fetchSource) await input.refresh(false)
          }
        }
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
    },
  )
}
