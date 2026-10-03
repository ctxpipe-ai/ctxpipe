import { createHash } from "node:crypto"
import type { SandboxHandle } from "@tanstack/ai-sandbox"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import Docker from "dockerode"
import { parseEnv } from "../../config/env.js"
import { getRepoReadCloneToken } from "../../models/github-installation.js"
import type {
  RunningSandboxProvider,
  SandboxInstanceRecord,
} from "../../models/workspace-sandboxes.js"
import { workspaceChatDockerImage } from "./chat-runtime.js"
import { hostedSandboxAccess } from "./hosted-sandbox-access.js"
import type { WorkspaceRevision } from "./revision.js"
import { dockerImageId } from "./sandbox-provider.js"
import {
  deleteVercelWorkspaceBase,
  startVercelWorkspaceBase,
  vercelCredentials,
  workspaceBaseTags,
} from "./vercel-sandbox-provider.js"
import { WORKSPACE_CHAT_OPENCODE_CLI } from "./workspace-chat-opencode-contract.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

/** Labels on every Docker base image, so a host prune can find ours. */
export const DOCKER_BASE_LABEL = "ai.ctxpipe.sandbox"
export const DOCKER_BASE_LABEL_VALUE = "workspace-base"
export const DOCKER_BASE_STORE_LABEL = "ai.ctxpipe.store"
export const DOCKER_BASE_ROW_LABEL = "ai.ctxpipe.base"

/**
 * Which database owns a Docker base image. Several deployments (or local
 * worktrees) can share one Docker daemon; a prune only touches images whose
 * owner rows live in its own database.
 */
export function sandboxStoreId(
  databaseUrl = process.env.DATABASE_URL ?? "",
): string {
  const url = new URL(databaseUrl)
  return createHash("sha256")
    .update(`${url.hostname}:${url.port || "5432"}${url.pathname}`)
    .digest("hex")
    .slice(0, 16)
}

/** A base build in progress: a running sandbox to clone into and capture. */
export type WorkspaceBaseBuild = {
  /** Recorded on the base row while building, so a lost build is cleaned up. */
  builderId: string
  handle: SandboxHandle
  /** Snapshot the prepared sandbox; the builder is gone or stopped afterwards. */
  capture: () => Promise<{ ref: string; providerSandboxId: string }>
  abandon: () => Promise<void>
}

/** How one provider builds Workspace bases. */
export type WorkspaceBaseBuilder = {
  provider: RunningSandboxProvider
  /**
   * The agent image the base is built on: the chat image's content id for
   * Docker, the runtime and OpenCode version for Vercel. A new one gets new
   * bases, and new conversations then start from those.
   */
  agentImage: string
  /** Clone credential for the stock clone; empty on Vercel (firewall). */
  cloneToken: string
  start: (base: {
    id: string
    orgId: string
    workspaceId: string
  }) => Promise<WorkspaceBaseBuild>
}

/** The agent identity for Vercel conversations; part of their sandbox key. */
export const VERCEL_AGENT_IMAGE = `vercel-node24/${WORKSPACE_CHAT_OPENCODE_CLI}`

/**
 * Docker: a container of the chat image clones and runs setup; `docker
 * commit` makes it an image (labelled with its owners) that conversations
 * start from with stock `dockerSandbox({ image })`.
 */
export function dockerWorkspaceBaseBuilder(input: {
  chatImage: string
  agentImage: string
  cloneToken: string
  docker?: Docker
}): WorkspaceBaseBuilder {
  const docker = input.docker ?? new Docker({ timeout: 120_000 })
  return {
    provider: "docker",
    agentImage: input.agentImage,
    cloneToken: input.cloneToken,
    async start(base) {
      const handle = await dockerSandbox({
        image: input.chatImage,
        dockerodeOptions: { timeout: 120_000 },
      }).create({})
      // Stock destroy waits for the keep-alive shell to ignore SIGTERM.
      const remove = () =>
        docker
          .getContainer(handle.id)
          .remove({ force: true, v: true })
          .catch((error: unknown) => {
            if (!dockerGone(error)) throw error
          })
      return {
        builderId: handle.id,
        handle,
        capture: async () => {
          const labels: Record<string, string> = {
            [DOCKER_BASE_LABEL]: DOCKER_BASE_LABEL_VALUE,
            [DOCKER_BASE_STORE_LABEL]: sandboxStoreId(),
            [DOCKER_BASE_ROW_LABEL]: base.id,
            "ai.ctxpipe.org": base.orgId,
            "ai.ctxpipe.workspace": base.workspaceId,
          }
          const committed = (await docker.getContainer(handle.id).commit({
            // Tagged, so a dangling-image prune never takes a base in use.
            repo: "ctxpipe-workspace-base",
            tag: base.id.replace(/[^\w.-]/g, "-").slice(0, 128),
            pause: true,
            changes: Object.entries(labels).map(
              ([key, value]) => `LABEL ${key}=${JSON.stringify(value)}`,
            ),
          })) as { Id: string }
          await remove()
          return { ref: committed.Id, providerSandboxId: committed.Id }
        },
        abandon: remove,
      }
    },
  }
}

/**
 * The builder for this deployment's provider, or null where conversations
 * have no provider snapshot (unsandboxed).
 */
export async function workspaceBaseBuilder(input: {
  provider: string
  orgId: string
  revision: WorkspaceRevision
}): Promise<WorkspaceBaseBuilder | null> {
  const { revision } = input
  if (input.provider === "docker") {
    const chatImage = workspaceChatDockerImage()
    const repoFullName = githubRepoFullNameFromWorkspaceUrl(revision.remote.url)
    const cloneToken = repoFullName
      ? ((await getRepoReadCloneToken(
          input.orgId,
          parseEnv(process.env as Record<string, string | undefined>),
          {
            githubConnectionId: revision.remote.connectionId ?? undefined,
            repoFullName,
          },
        )) ?? "")
      : ""
    return dockerWorkspaceBaseBuilder({
      chatImage,
      agentImage: await dockerImageId(chatImage),
      cloneToken,
    })
  }
  if (input.provider === "vercel") {
    const hosted = await hostedSandboxAccess({
      orgId: input.orgId,
      githubConnectionId: revision.remote.connectionId,
      desiredUrl: revision.remote.url,
    })
    if (!hosted.ok) throw new Error(hosted.error)
    return {
      provider: "vercel",
      agentImage: VERCEL_AGENT_IMAGE,
      cloneToken: "",
      async start() {
        const build = await startVercelWorkspaceBase({
          credentials: hosted.credentials,
          mintGitToken: hosted.mintGitToken,
          backendHost: hosted.backendHost,
          tags: workspaceBaseTags(hosted.environment),
        })
        return {
          builderId: build.name,
          handle: build.handle,
          capture: async () => ({
            ref: (await build.capture()).snapshotId,
            providerSandboxId: build.name,
          }),
          abandon: build.abandon,
        }
      },
    }
  }
  return null
}

function dockerGone(error: unknown): boolean {
  return (error as { statusCode?: number }).statusCode === 404
}

/**
 * Delete what a base row holds at its provider: a builder still running and
 * the captured image or snapshot. Gone counts as deleted. A Docker image a
 * running container still uses is refused by the daemon, so the row stays
 * for a retry.
 */
export async function deleteWorkspaceBaseArtifacts(
  row: Pick<
    SandboxInstanceRecord,
    "provider" | "providerSandboxId" | "latestSnapshotId"
  >,
  docker = new Docker({ timeout: 30_000 }),
): Promise<void> {
  if (row.provider === "docker") {
    const builder =
      row.providerSandboxId && row.providerSandboxId !== row.latestSnapshotId
        ? row.providerSandboxId
        : undefined
    if (builder)
      await docker
        .getContainer(builder)
        .remove({ force: true, v: true })
        .catch((error: unknown) => {
          if (!dockerGone(error)) throw error
        })
    if (row.latestSnapshotId)
      await docker
        .getImage(row.latestSnapshotId)
        .remove({ force: true })
        .catch((error: unknown) => {
          if (!dockerGone(error)) throw error
        })
    return
  }
  if (row.provider === "vercel") {
    await deleteVercelWorkspaceBase({
      credentials: await vercelCredentials(),
      snapshotId: row.latestSnapshotId,
      builderName: row.providerSandboxId,
    })
    return
  }
  throw new Error(
    `Cannot delete a Workspace base for provider ${row.provider ?? "unknown"}`,
  )
}
