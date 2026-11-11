import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SandboxHandle, SandboxProvider } from "@tanstack/ai-sandbox"

import { repositoryRevisionCheckoutKey } from "../../../../../shared/workspace-checkout.js"
import { type Env, parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import { listWorkspaceUnitsAtRevision } from "../../models/workspaces.js"
import { gitRemoteEnvironment } from "../../services/git/clone-tree.js"
import { resolvePlainGitRemote } from "../../services/git/plain-git-remote.js"
import { agentCoreRuntime } from "../workspaces/agentcore-sandbox-provider.js"
import { ingestSandboxThreadId } from "../workspaces/chat-lifecycle.js"
import { workspaceChatDockerImage } from "../workspaces/chat-runtime.js"
import {
  agentCoreIngestSandboxProvider,
  dockerIngestSandboxProvider,
  type IngestEgress,
  type IngestRepository,
  refreshIngestSandboxEgress,
  revokeIngestGitTokens,
} from "../workspaces/ingest-sandbox-egress.js"
import { ingestSandbox } from "../workspaces/ingest-sandbox.js"
import { resolveRepositoryReadCredential } from "../workspaces/resolve-revision.js"
import { sandboxFetchUrl } from "../workspaces/sandbox-credential-rules.js"
import { postgresSandboxLocks } from "../workspaces/sandbox-lock-store.js"
import {
  configuredAgentCoreProvider,
  lockedSandboxProvider,
} from "../workspaces/sandbox-provider.js"
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
import {
  agentCoreRootExec,
  dockerRootExec,
  type RootExec,
} from "./ingest-root.js"
import {
  discoverIngestRoots,
  ingestAgentEnv,
  prepareIngestShard,
  probeIngestModelProxy,
  runIngestShardStep,
} from "./ingest-shard-ops.js"
import {
  type IngestRuntimeStep,
  type IngestShardRuntime,
  type IngestShardRuntimeFactory,
  type IngestShardSpec,
  ingestCallbackOrigin,
} from "./ingest-shard-runtime.js"
import { withShardStep } from "./ingest-shard-step.js"
import { logIngestEvent } from "./ingest-telemetry.js"
import {
  INGEST_TOOL_BRIDGE_PATH,
  workspaceCheckoutLabel,
} from "./ingest-tools.js"
import { withExistingRootFiles } from "./ingestion-plan.js"
import { ingestionOrg } from "./ingestion-v2-resolve.js"
import { runGit } from "./run-git.js"

/*
 * The production runtime of an ingest shard (ADR-052 sections 7 and 8).
 * Each call holds the shard lock (`ingest:<runId>:<shard>`), mints the
 * step's model and tool-bridge capabilities with the lock owner, gives the
 * sandbox's egress those credentials, and then runs the shard commands.
 *
 * Docker and AgentCore: the shard's Agent Vault adds each credential, and
 * the provider refuses a host where traffic is not forced through the vault.
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
 * The projection read of a step index. A workflow step has no request org, so
 * this opens the org's database context. `orgId` comes from the trusted spec.
 */
export function stepIndexProjection(
  orgId: string,
  workspaceId: string,
  pinnedRevision: string,
) {
  return withOrgDbContext(orgId, () =>
    listWorkspaceUnitsAtRevision(workspaceId, pinnedRevision),
  )
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
            stepIndexProjection(
              input.orgId,
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

/**
 * The repositories of a shard: the source and each destination. Each
 * destination is a GitHub repository. The source is a GitHub repository, or
 * a plain git repository whose URL must obey the plain git URL policy of
 * the deployment mode (CTX-815); the sandbox reads it with no credential.
 */
async function shardRepositories(
  spec: IngestShardSpec,
): Promise<IngestRepository[]> {
  const github = (repo: { url: string; githubConnectionId: string }) => {
    const fullName = githubRepoFullNameFromWorkspaceUrl(repo.url)
    if (!fullName)
      throw new Error("Ingest destination repositories must be on GitHub")
    return { fullName, githubConnectionId: repo.githubConnectionId }
  }
  if (spec.source.kind !== "git")
    return [github(spec.source), ...spec.destinations.map(github)]
  const { host, path, port } = await resolvePlainGitRemote(spec.source.url)
  const source: IngestRepository = { kind: "git", host, path, port }
  return [source, ...spec.destinations.map(github)]
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
              // A Workspace read uses the published checkout of the
              // repository, so the label names only the Workspace.
              checkoutKey: workspaceCheckoutLabel(d.workspaceId),
            },
          ]
        : [],
    ),
  ]
  return {
    repositories: await shardRepositories(spec),
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

/** The deployment's ingest provider: Docker (the default) or AgentCore. */
function ingestIsolation(): "docker" | "agentcore" {
  const isolation = lockedSandboxProvider(process.env) ?? "docker"
  assertIngestProvider(isolation)
  return isolation === "agentcore" ? isolation : "docker"
}

type ShardBox = {
  sandbox: ReturnType<typeof ingestSandbox>
  /** Root commands in the sandbox `id`. */
  root: (id: string) => Promise<RootExec>
}

/** The shard's sandbox; without `egress` it can only attach and destroy. */
async function shardSandbox(
  target: {
    orgId: string
    runId: string
    shard: number
    workspaceId: string
  },
  options: { egress?: IngestEgress; signal?: AbortSignal } = {},
): Promise<ShardBox> {
  const { egress, signal } = options
  const isolation = ingestIsolation()
  const sandboxFor = (provider: SandboxProvider, image: string) =>
    ingestSandbox({
      orgId: target.orgId,
      workspaceId: target.workspaceId,
      runId: target.runId,
      shard: target.shard,
      isolation,
      provider,
      image,
      ...(signal ? { signal } : {}),
    })
  if (isolation === "agentcore") {
    // The same path as Docker: the shard's vault adds each credential.
    const runtime = agentCoreRuntime()
    if (!runtime)
      throw new Error("AgentCore ingest sandboxes need AGENTCORE_RUNTIME_ARN")
    return {
      // One fixed value, as for chat.
      sandbox: sandboxFor(
        agentCoreIngestSandboxProvider({
          orgId: target.orgId,
          runId: target.runId,
          shard: target.shard,
          sessions: configuredAgentCoreProvider(),
          ...(egress ? { egress } : {}),
        }),
        "agentcore-agent",
      ),
      root: async (id) => agentCoreRootExec(runtime, id),
    }
  }
  const image = workspaceChatDockerImage()
  return {
    sandbox: sandboxFor(
      dockerIngestSandboxProvider({
        orgId: target.orgId,
        runId: target.runId,
        shard: target.shard,
        image,
        ...(egress ? { egress } : {}),
      }),
      image,
    ),
    root: async (id) => dockerRootExec(id),
  }
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
    return held.index.at(step.baseCommit, step.fetchRef)
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
        const box = await shardSandbox(target, { egress, signal: lockSignal })
        const existing = await box.sandbox.ensureExisting()
        const existingRoot = existing ? await box.root(existing.id) : null
        // A process of an earlier step must not get this step's credentials.
        if (existingRoot) await stopIngestAgentProcesses(existingRoot)
        return withShardStep({
          existingRoot,
          plainGitSource: spec.source.kind === "git",
          refresh: (fetchSource) =>
            refreshIngestSandboxEgress({
              orgId: spec.orgId,
              runId: spec.runId,
              shard: spec.shard,
              egress,
              fetchSource,
            }),
          attach: async () => {
            const handle = existing ?? (await box.sandbox.ensure())
            const root = existingRoot ?? (await box.root(handle.id))
            const agentEnv = await ingestAgentEnv(root, {
              modelProxyUrl: egress.modelProxyUrl,
            })
            return { handle, root, agentEnv }
          },
          prepare: async ({ handle, root, agentEnv }) => {
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
              source: {
                url: sandboxFetchUrl(spec.source),
                sha: spec.source.sha,
                // No later fetch can get a missing blob of a plain git
                // source: clone each blob of the window now.
                blobless: spec.source.kind !== "git",
              },
              contexts: spec.destinations.map((destination) => ({
                ...destination,
                url: sandboxFetchUrl(destination),
              })),
              now: new Date(),
              signal: lockSignal,
            })
            // Before the first model step of the sandbox: only the status.
            logIngestEvent("info", "ingestion-v2.model-proxy-probe", {
              ingestionRunId: spec.runId,
              shard: spec.shard,
              status: await probeIngestModelProxy(root, agentEnv),
            })
          },
          run: (box) => fn({ ...box, signal: lockSignal }),
          stopAgents: stopIngestAgentProcesses,
          logContext: { orgId: spec.orgId, runId: spec.runId },
        })
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
          const { json, rootFiles } = await indexOf(step)
          const { usage } = await runIngestShardStep(root, {
            step: {
              ...step,
              rootMap: withExistingRootFiles(step.rootMap, rootFiles),
              signal,
            },
            agentEnv,
            remote: sandboxFetchUrl(destination),
            sourceUrl: spec.source.url,
            sourcePath: destination.sourcePath,
            index: json,
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

/** Delete the shard's sandbox and revoke each GitHub token of the shard. */
async function destroyShard(target: {
  orgId: string
  runId: string
  shard: number
  workspaceId: string
}): Promise<void> {
  await withShardLock(target, async () => {
    try {
      await (await shardSandbox(target)).sandbox.destroy()
    } finally {
      // Also when no sandbox row is left. A token that is left is logged;
      // the sweep revokes it after the run.
      await revokeIngestGitTokens(target)
    }
  })
}

/** The production shard runtime factory. */
export const sandboxIngestShardRuntime: IngestShardRuntimeFactory =
  Object.assign(shardRuntime, {
    // Destroy makes no sandbox and mints no credential.
    destroy: destroyShard,
  })
