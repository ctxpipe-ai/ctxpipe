import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SandboxHandle } from "@tanstack/ai-sandbox"
import {
  repositoryRevisionCheckoutKey,
  workspaceCheckoutKey,
} from "../../../../../shared/workspace-checkout.js"
import { type Env, parseEnv } from "../../config/env.js"
import { listWorkspaceUnitsAtRevision } from "../../models/workspaces.js"
import { gitRemoteEnvironment } from "../../services/git/clone-tree.js"
import { ingestSandboxThreadId } from "../workspaces/chat-lifecycle.js"
import { workspaceChatDockerImage } from "../workspaces/chat-runtime.js"
import { ingestSandbox } from "../workspaces/ingest-sandbox.js"
import {
  dockerIngestSandboxProvider,
  type IngestEgress,
  refreshIngestSandboxEgress,
} from "../workspaces/ingest-sandbox-egress.js"
import { resolveRepositoryReadCredential } from "../workspaces/resolve-revision.js"
import { postgresSandboxLocks } from "../workspaces/sandbox-lock-store.js"
import { lockedSandboxProvider } from "../workspaces/sandbox-provider.js"
import { workspaceChatCompletionsPath } from "../workspaces/workspace-chat-model-proxy.js"
import { workspaceChatOpenCodeContract } from "../workspaces/workspace-chat-opencode-contract.js"
import {
  mintWorkspaceIngestRunCapability,
  mintWorkspaceIngestToolsCapability,
} from "../workspaces/workspace-chat-run-capability.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../workspaces/write-status.js"
import { stepContextIndex } from "./context-index.js"
import { holdScratch, releaseScratch } from "./held-scratch.js"
import { ingestOpenCodeConfig } from "./ingest-opencode.js"
import {
  assertIngestProvider,
  collectIngestStep,
  stopIngestAgentProcesses,
} from "./ingest-prepare.js"
import { dockerRootExec, type RootExec } from "./ingest-root.js"
import {
  discoverIngestRoots,
  ingestAgentEnv,
  ingestShardPrepared,
  prepareIngestShard,
  runIngestShardStep,
} from "./ingest-shard-ops.js"
import {
  type IngestRuntimeStep,
  type IngestShardRuntime,
  type IngestShardRuntimeFactory,
  type IngestShardSpec,
  ingestCallbackOrigin,
} from "./ingest-shard-runtime.js"
import { INGEST_TOOL_BRIDGE_PATH } from "./ingest-tools.js"
import { ingestionOrg } from "./ingestion-v2-resolve.js"
import { runGit } from "./run-git.js"

/*
 * The production runtime of an ingest shard (ADR-052 sections 7 and 8).
 * Each call holds the shard lock (`ingest:<runId>:<shard>`), mints the
 * step's model and tool-bridge capabilities with the lock owner, gives the
 * sandbox's egress those credentials, and then runs the shard commands.
 *
 * Only Docker runs now: the Docker provider refuses a host where traffic is
 * not forced through Agent Vault. A hosted (Vercel) shard waits for the
 * backend egress proxy (T03b) and the T12 proof.
 */

/** Model names for the tiers that the skill plan uses. */
function ingestModels() {
  const medium = workspaceChatOpenCodeContract(process.env, "medium")
  const fast = workspaceChatOpenCodeContract(process.env, "fast")
  if (!medium.ok) throw new Error(medium.error)
  if (!fast.ok) throw new Error(fast.error)
  return { medium: medium.modelBase, fast: fast.modelBase }
}

/**
 * The T07 context index of each step of one Workspace in a shard (ADR-052
 * section 6): one scratch repository and one projection, kept for the shard
 * on this worker. Each step fetches only its new commits.
 */
function heldStepIndex(input: {
  orgId: string
  runId: string
  shard: number
  workspaceId: string
  url: string
  githubConnectionId: string
  pinnedRevision: string
  sourcePath: string
  rootPath: string | undefined
}) {
  return holdScratch(
    `index:${input.runId}:${input.shard}:${input.workspaceId}`,
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "ctxpipe-ingest-index-"))
      try {
        await runGit(dir, ["init", "--quiet", "--bare"])
      } catch (error) {
        await rm(dir, { recursive: true, force: true })
        throw error
      }
      return {
        dir,
        index: stepContextIndex({
          workspaceId: input.workspaceId,
          pinnedRevision: input.pinnedRevision,
          sourcePath: input.sourcePath,
          repoDir: dir,
          rootPath: input.rootPath,
          projection: () =>
            listWorkspaceUnitsAtRevision(
              input.workspaceId,
              input.pinnedRevision,
            ),
          fetch: async (what, into) => {
            const token = await resolveRepositoryReadCredential({
              orgId: input.orgId,
              env: parseEnv(process.env),
              remote: {
                url: input.url,
                connectionId: input.githubConnectionId,
              },
            })
            await runGit(
              dir,
              [
                "fetch",
                "--quiet",
                "--no-tags",
                "--depth=1",
                "--",
                input.url,
                `+${what}:${into}`,
              ],
              { env: gitRemoteEnvironment({ url: input.url, token }) },
            )
          },
        }),
      }
    },
  )
}

/** Delete this worker's index repositories of one shard. */
export function releaseIngestStepIndexes(
  runId: string,
  shard: number,
): Promise<void> {
  return releaseScratch(`index:${runId}:${shard}:`)
}

/** The GitHub repositories of a shard: the source and each destination. */
function shardRepositories(spec: IngestShardSpec) {
  return [
    {
      url: spec.source.url,
      githubConnectionId: spec.source.githubConnectionId,
    },
    ...spec.destinations,
  ].map((repo) => {
    const fullName = githubRepoFullNameFromWorkspaceUrl(repo.url)
    if (!fullName) throw new Error("Ingest repositories must be on GitHub")
    return { fullName, githubConnectionId: repo.githubConnectionId }
  })
}

/**
 * The egress of one step: the model and tool-bridge capabilities for the
 * shard lock owner `lockOwner`, on the API origin (never the worker's). A
 * later lock owner gets new capabilities; the old ones stop at the API.
 */
export async function ingestShardStepEgress(input: {
  spec: IngestShardSpec
  lockOwner: string
  step: string
  env?: Env
}): Promise<IngestEgress> {
  const { spec } = input
  const env = input.env ?? parseEnv(process.env)
  const org = await ingestionOrg(spec.orgId)
  const origin = ingestCallbackOrigin(env)
  const modelProxyUrl = `${origin}${workspaceChatCompletionsPath(org.slug)}`
  const claims = {
    authSecret: env.AUTH_SECRET,
    orgId: spec.orgId,
    orgSlug: org.slug,
    runId: spec.runId,
    shard: spec.shard,
    step: input.step,
    lockOwner: input.lockOwner,
  }
  const checkouts = [
    ...(spec.source.repositoryId
      ? [
          {
            repositoryId: spec.source.repositoryId,
            checkoutKey: repositoryRevisionCheckoutKey(spec.source.sha),
            sha: spec.source.sha,
          },
        ]
      : []),
    ...spec.destinations.flatMap((d) =>
      d.repositoryId
        ? [
            {
              repositoryId: d.repositoryId,
              checkoutKey: workspaceCheckoutKey(
                d.workspaceId,
                d.pinnedRevision,
              ),
              sha: d.pinnedRevision,
            },
          ]
        : [],
    ),
  ]
  return {
    repositories: shardRepositories(spec),
    modelProxyUrl,
    capability: await mintWorkspaceIngestRunCapability(claims),
    bridge: {
      url: `${origin}${INGEST_TOOL_BRIDGE_PATH}`,
      // With no codesearch checkout, the bridge refuses each call.
      token: checkouts.length
        ? await mintWorkspaceIngestToolsCapability({ ...claims, checkouts })
        : "ctxpipe-no-tools",
    },
  }
}

/** Hold the shard lock; `fn` gets the lock owner for the capabilities. */
function withShardLock<T>(
  target: { orgId: string; runId: string; shard: number },
  fn: (lockOwner: string, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let lockOwner = ""
  const controller = new AbortController()
  if (signal?.aborted) controller.abort(signal.reason)
  else if (signal)
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    })
  return postgresSandboxLocks(
    target.orgId,
    controller,
    undefined,
    (receipt) => {
      lockOwner = receipt.owner
    },
  ).withLock(ingestSandboxThreadId(target.runId, target.shard), () =>
    fn(lockOwner, controller.signal),
  )
}

/** The shard's sandbox; without `egress` it can only attach and destroy. */
function shardSandbox(
  target: {
    orgId: string
    runId: string
    shard: number
    workspaceId: string
  },
  egress?: IngestEgress,
  signal?: AbortSignal,
) {
  const isolation = lockedSandboxProvider(process.env) ?? "docker"
  assertIngestProvider(isolation)
  if (isolation !== "docker")
    throw new Error(
      "Hosted ingest sandboxes wait for the backend egress proxy (T03b) and its live proof (T12)",
    )
  const image = workspaceChatDockerImage()
  return ingestSandbox({
    orgId: target.orgId,
    workspaceId: target.workspaceId,
    runId: target.runId,
    shard: target.shard,
    isolation,
    provider: dockerIngestSandboxProvider({
      orgId: target.orgId,
      runId: target.runId,
      shard: target.shard,
      image,
      ...(egress ? { egress } : {}),
    }),
    image,
    ...(signal ? { signal } : {}),
  })
}

function shardRuntime(spec: IngestShardSpec): IngestShardRuntime {
  const firstWorkspace = spec.destinations[0]?.workspaceId
  if (!firstWorkspace) throw new Error("An ingest shard needs a destination")
  const target = {
    orgId: spec.orgId,
    runId: spec.runId,
    shard: spec.shard,
    workspaceId: firstWorkspace,
  }
  const indexOf = async (step: IngestRuntimeStep) => {
    const destination = spec.destinations.find(
      (d) => d.workspaceId === step.workspaceId,
    )
    if (!destination)
      throw new Error("The step's Workspace is not in the shard")
    const held = await heldStepIndex({
      orgId: spec.orgId,
      runId: spec.runId,
      shard: spec.shard,
      workspaceId: step.workspaceId,
      url: destination.url,
      githubConnectionId: destination.githubConnectionId,
      pinnedRevision: destination.pinnedRevision,
      sourcePath: destination.sourcePath,
      rootPath: destination.rootPath,
    })
    return (await held.index.at(step.baseCommit, step.fetchRef)).json
  }

  /**
   * Hold the shard lock, attach to the sandbox (or make and prepare it
   * again), give it this step's credentials, and run `fn`.
   */
  function withShard<T>(
    step: string,
    fn: (input: {
      handle: SandboxHandle
      root: RootExec
      agentEnv: Record<string, string>
      /** Aborts at the step limit or when the shard lock is lost. */
      signal: AbortSignal
    }) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return withShardLock(
      target,
      async (lockOwner, lockSignal) => {
        const egress = await ingestShardStepEgress({ spec, lockOwner, step })
        const sandbox = shardSandbox(target, egress, lockSignal)
        const existing = await sandbox.ensureExisting()
        // A process of an earlier step must not get this step's credentials.
        if (existing)
          await stopIngestAgentProcesses(dockerRootExec(existing.id))
        // A new sandbox gets this egress at create; an existing one gets it now.
        if (existing)
          await refreshIngestSandboxEgress({
            orgId: spec.orgId,
            runId: spec.runId,
            shard: spec.shard,
            egress,
          })
        const handle = existing ?? (await sandbox.ensure())
        const root = dockerRootExec(handle.id)
        const agentEnv = await ingestAgentEnv(root, {
          modelProxyUrl: egress.modelProxyUrl,
        })
        if (!(await ingestShardPrepared(root))) {
          const models = ingestModels()
          await prepareIngestShard(handle, root, {
            bundle: spec.bundle,
            opencodeConfig: ingestOpenCodeConfig({
              modelBase: models.medium,
              models: [models.fast],
              skills: spec.bundle.skills,
              proxyAddsCredentials: true,
              toolBridgeUrl: egress.bridge.url,
            }),
            agentEnv,
            source: { url: spec.source.url, sha: spec.source.sha },
            contexts: spec.destinations,
            now: new Date(),
          })
        }
        return fn({ handle, root, agentEnv, signal: lockSignal })
      },
      signal,
    )
  }

  return {
    ensure: () => withShard("ensure-sandbox", async () => undefined),
    discoverRoots: () =>
      withShard("discover-roots", ({ root, agentEnv, signal }) =>
        discoverIngestRoots(root, agentEnv, signal),
      ),
    runStep: (step) =>
      withShard(
        step.name,
        async ({ handle, root, agentEnv, signal }) => {
          const models = step.run === "model" ? ingestModels() : undefined
          const destination = spec.destinations.find(
            (d) => d.workspaceId === step.workspaceId,
          )
          if (!destination)
            throw new Error("The step's Workspace is not in the shard")
          const { usage } = await runIngestShardStep(root, {
            step: { ...step, signal },
            agentEnv,
            remote: destination.url,
            sourceUrl: spec.source.url,
            sourcePath: destination.sourcePath,
            index: await indexOf(step),
            ...(models
              ? {
                  model: `ctxpipe/${step.tier === "fast" ? models.fast : models.medium}`,
                }
              : {}),
          })
          return {
            tar: await collectIngestStep(handle, root),
            ...(usage ? { usage } : {}),
          }
        },
        step.signal,
      ),
  }
}

export const sandboxIngestShardRuntime: IngestShardRuntimeFactory =
  Object.assign(shardRuntime, {
    // Destroy makes no sandbox and mints no credential.
    destroy: (target: {
      orgId: string
      runId: string
      shard: number
      workspaceId: string
    }) => withShardLock(target, () => shardSandbox(target).destroy()),
  })
