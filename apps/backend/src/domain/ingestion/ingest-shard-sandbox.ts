import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SandboxHandle } from "@tanstack/ai-sandbox"
import {
  repositoryRevisionCheckoutKey,
  workspaceCheckoutKey,
} from "../../../../../shared/workspace-checkout.js"
import { type Env, parseEnv } from "../../config/env.js"
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
import { buildContextIndex } from "./context-index.js"
import { ingestOpenCodeConfig } from "./ingest-opencode.js"
import { assertIngestProvider, collectIngestStep } from "./ingest-prepare.js"
import { dockerRootExec, type RootExec } from "./ingest-root.js"
import {
  discoverIngestRoots,
  ingestAgentEnv,
  ingestShardPrepared,
  prepareIngestShard,
  runIngestShardStep,
} from "./ingest-shard-ops.js"
import {
  ingestCallbackOrigin,
  type IngestShardRuntime,
  type IngestShardRuntimeFactory,
  type IngestShardSpec,
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

/** The T07 context index of a destination at its pinned revision. */
async function contextIndexJson(input: {
  orgId: string
  workspaceId: string
  url: string
  githubConnectionId: string
  sha: string
  sourceUrl: string
}): Promise<string> {
  const env = parseEnv(process.env)
  const token = await resolveRepositoryReadCredential({
    orgId: input.orgId,
    env,
    remote: { url: input.url, connectionId: input.githubConnectionId },
  })
  const dir = await mkdtemp(join(tmpdir(), "ctxpipe-ingest-index-"))
  try {
    await runGit(dir, ["init", "--quiet", "--bare"])
    await runGit(
      dir,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--depth=1",
        "--",
        input.url,
        input.sha,
      ],
      { env: gitRemoteEnvironment({ url: input.url, token }) },
    )
    const { json } = await buildContextIndex({
      workspaceId: input.workspaceId,
      sha: input.sha,
      sourceUrl: input.sourceUrl,
      repoDir: dir,
    })
    return json
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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
              checkoutKey: workspaceCheckoutKey(d.workspaceId, d.pinnedRevision),
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
  if (signal)
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    })
  return postgresSandboxLocks(target.orgId, controller, undefined, (receipt) => {
    lockOwner = receipt.owner
  }).withLock(ingestSandboxThreadId(target.runId, target.shard), () =>
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
  const indexes = new Map<string, Promise<string>>()
  const indexOf = (workspaceId: string) => {
    const destination = spec.destinations.find(
      (d) => d.workspaceId === workspaceId,
    )
    if (!destination)
      throw new Error("The step's Workspace is not in the shard")
    let pending = indexes.get(workspaceId)
    if (!pending) {
      pending = contextIndexJson({
        orgId: spec.orgId,
        workspaceId,
        url: destination.url,
        githubConnectionId: destination.githubConnectionId,
        sha: destination.pinnedRevision,
        sourceUrl: spec.source.url,
      })
      pending.catch(() => indexes.delete(workspaceId))
      indexes.set(workspaceId, pending)
    }
    return pending
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
    }) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return withShardLock(
      target,
      async (lockOwner, lockSignal) => {
        const egress = await ingestShardStepEgress({ spec, lockOwner, step })
        const sandbox = shardSandbox(target, egress, lockSignal)
        const existing = await sandbox.ensureExisting()
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
        return fn({ handle, root, agentEnv })
      },
      signal,
    )
  }

  return {
    ensure: () => withShard("ensure-sandbox", async () => undefined),
    discoverRoots: () =>
      withShard("discover-roots", ({ root, agentEnv }) =>
        discoverIngestRoots(root, agentEnv),
      ),
    runStep: (step) =>
      withShard(
        step.name,
        async ({ handle, root, agentEnv }) => {
          const models = step.run === "model" ? ingestModels() : undefined
          const { more } = await runIngestShardStep(root, {
            step,
            agentEnv,
            remote:
              spec.destinations.find((d) => d.workspaceId === step.workspaceId)
                ?.url ?? "",
            sourceUrl: spec.source.url,
            index: await indexOf(step.workspaceId),
            ...(models
              ? {
                  model: `ctxpipe/${step.tier === "fast" ? models.fast : models.medium}`,
                }
              : {}),
          })
          return { tar: await collectIngestStep(handle, root), more }
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
