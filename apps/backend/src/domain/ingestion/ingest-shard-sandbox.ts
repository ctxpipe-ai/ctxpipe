import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SandboxHandle } from "@tanstack/ai-sandbox"
import { eq } from "drizzle-orm"
import {
  repositoryRevisionCheckoutKey,
  workspaceCheckoutKey,
} from "../../../../../shared/workspace-checkout.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
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
import { sandboxCallbackHost } from "../workspaces/workspace-chat-callback.js"
import { workspaceChatCompletionsBaseUrl } from "../workspaces/workspace-chat-model-proxy.js"
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
import type {
  IngestShardRuntime,
  IngestShardRuntimeFactory,
  IngestShardSpec,
} from "./ingest-shard-runtime.js"
import { INGEST_TOOL_BRIDGE_PATH } from "./ingest-tools.js"
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

async function orgSlugOf(orgId: string): Promise<string> {
  const [row] = await getSystemDb()
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
  if (!row) throw new Error("The ingestion run's organization is gone")
  return row.slug
}

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

export const sandboxIngestShardRuntime: IngestShardRuntimeFactory = (
  spec: IngestShardSpec,
): IngestShardRuntime => {
  const isolation = lockedSandboxProvider(process.env) ?? "docker"
  assertIngestProvider(isolation)
  if (isolation !== "docker")
    throw new Error(
      "Hosted ingest sandboxes wait for the backend egress proxy (T03b) and its live proof (T12)",
    )
  const firstWorkspace = spec.destinations[0]?.workspaceId
  if (!firstWorkspace) throw new Error("An ingest shard needs a destination")
  const threadId = ingestSandboxThreadId(spec.runId, spec.shard)
  const image = workspaceChatDockerImage()
  const repositories = [
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

  /** The step's egress: model and tool-bridge capabilities for `lockOwner`. */
  async function stepEgress(lockOwner: string, step: string) {
    const env = parseEnv(process.env)
    const orgSlug = await orgSlugOf(spec.orgId)
    const callbackHost = await sandboxCallbackHost()
    const modelProxyUrl = workspaceChatCompletionsBaseUrl({
      isolation,
      orgSlug,
      port: Number(process.env.PORT) || 3000,
      ...(callbackHost ? { callbackHost } : {}),
    })
    const claims = {
      authSecret: env.AUTH_SECRET,
      orgId: spec.orgId,
      orgSlug,
      runId: spec.runId,
      shard: spec.shard,
      step,
      lockOwner,
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
    const egress: IngestEgress = {
      repositories,
      modelProxyUrl,
      capability: await mintWorkspaceIngestRunCapability(claims),
      bridge: {
        url: `${new URL(modelProxyUrl).origin}${INGEST_TOOL_BRIDGE_PATH}`,
        // With no codesearch checkout, the bridge refuses each call.
        token: checkouts.length
          ? await mintWorkspaceIngestToolsCapability({ ...claims, checkouts })
          : "ctxpipe-no-tools",
      },
    }
    return egress
  }

  const shardSandbox = (egress: IngestEgress, signal?: AbortSignal) =>
    ingestSandbox({
      orgId: spec.orgId,
      workspaceId: firstWorkspace,
      runId: spec.runId,
      shard: spec.shard,
      isolation,
      provider: dockerIngestSandboxProvider({
        orgId: spec.orgId,
        runId: spec.runId,
        shard: spec.shard,
        image,
        egress,
      }),
      image,
      ...(signal ? { signal } : {}),
    })

  /** Hold the shard lock; `fn` gets the lock owner for the capabilities. */
  function withShardLock<T>(
    fn: (lockOwner: string, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let lockOwner = ""
    const controller = new AbortController()
    if (signal)
      signal.addEventListener("abort", () => controller.abort(signal.reason), {
        once: true,
      })
    return postgresSandboxLocks(
      spec.orgId,
      controller,
      undefined,
      (receipt) => {
        lockOwner = receipt.owner
      },
    ).withLock(threadId, () => fn(lockOwner, controller.signal))
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
      remoteOf: (workspaceId: string) => string
    }) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return withShardLock(async (lockOwner, lockSignal) => {
      const egress = await stepEgress(lockOwner, step)
      const sandbox = shardSandbox(egress, lockSignal)
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
      return fn({
        handle,
        root,
        agentEnv,
        remoteOf: (workspaceId) =>
          spec.destinations.find((d) => d.workspaceId === workspaceId)?.url ??
          "",
      })
    }, signal)
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
        async ({ handle, root, agentEnv, remoteOf }) => {
          const models = step.run === "model" ? ingestModels() : undefined
          await runIngestShardStep(root, {
            step,
            agentEnv,
            remote: remoteOf(step.workspaceId),
            index: await indexOf(step.workspaceId),
            ...(models
              ? {
                  model: `ctxpipe/${step.tier === "fast" ? models.fast : models.medium}`,
                }
              : {}),
          })
          return collectIngestStep(handle, root)
        },
        step.signal,
      ),
    // Destroy never makes a sandbox; it opens no vault, so the egress is not used.
    destroy: () =>
      withShardLock(() =>
        shardSandbox({
          repositories,
          modelProxyUrl: "http://unused.invalid",
          capability: "unused",
          bridge: { url: "http://unused.invalid", token: "unused" },
        }).destroy(),
      ),
  }
}
