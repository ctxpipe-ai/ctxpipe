import { createHash } from "node:crypto"
import type { SandboxHandle } from "@tanstack/ai-sandbox"
import { DockerHandle } from "@tanstack/ai-sandbox-docker"
import { APIError, Snapshot } from "@vercel/sandbox"
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
import { discoverSandboxProvider, dockerImageId } from "./sandbox-provider.js"
import {
  deleteVercelBuilder,
  startVercelWorkspaceBase,
  vercelAgentSnapshot,
  vercelCredentials,
  workspaceBaseTags,
} from "./vercel-sandbox-provider.js"
import { WORKSPACE_CHAT_OPENCODE_CLI } from "./workspace-chat-opencode-contract.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

/** Docker labels on what our code creates, so a host prune can find it. */
export const DOCKER_LABELS = {
  /** `workspace-base` on base images (and the containers started from them), `workspace-base-builder` on builders. */
  kind: "ai.ctxpipe.sandbox",
  /** The deployment's database, so a prune never touches another deployment's objects. */
  store: "ai.ctxpipe.store",
  /** The base row the object belongs to. */
  base: "ai.ctxpipe.base",
  org: "ai.ctxpipe.org",
  workspace: "ai.ctxpipe.workspace",
} as const

/** The agent identity for Vercel conversations; part of their sandbox key. */
export const VERCEL_AGENT_IMAGE = `vercel-agent/${WORKSPACE_CHAT_OPENCODE_CLI}`

/** The deployment's sandbox provider and the agent image bases are built on. */
export type SandboxAgent = { provider: RunningSandboxProvider; image: string }

/**
 * The agent image conversation sandboxes use (and their key covers): the
 * chat image's content id on Docker, the OpenCode version on Vercel.
 */
export function sandboxAgentImage(
  provider: RunningSandboxProvider,
): Promise<string> {
  return provider === "docker"
    ? dockerImageId(workspaceChatDockerImage())
    : Promise.resolve(VERCEL_AGENT_IMAGE)
}

/**
 * The deployment's provider and agent image, or null where conversations
 * have no provider snapshot (unsandboxed). Throws when they cannot be read.
 */
export async function currentSandboxAgent(): Promise<SandboxAgent | null> {
  const provider = await discoverSandboxProvider()
  if (provider !== "docker" && provider !== "vercel") return null
  return { provider, image: await sandboxAgentImage(provider) }
}

function appEnv() {
  return parseEnv(process.env as Record<string, string | undefined>)
}

/**
 * Which database owns a Docker object. Several deployments (or local
 * worktrees) can share one daemon; a prune only touches its own.
 */
export function sandboxStoreId(): string {
  const url = new URL(appEnv().DATABASE_URL)
  return createHash("sha256")
    .update(`${url.hostname}:${url.port || "5432"}${url.pathname}`)
    .digest("hex")
    .slice(0, 16)
}

/**
 * Remove a container or image. Gone counts as removed; `in-use` is the
 * daemon refusing (409), e.g. an image a running container uses.
 */
export async function removeDockerObject(
  remove: () => Promise<unknown>,
): Promise<"removed" | "in-use"> {
  try {
    await remove()
    return "removed"
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode
    if (status === 404) return "removed"
    if (status === 409) return "in-use"
    throw error
  }
}

/** A base build in progress: a running builder to clone into and capture. */
export type WorkspaceBaseBuild = {
  /** Recorded on the base row at once, so a lost build is cleaned up. */
  builderId: string
  handle: SandboxHandle
  /** Snapshot the prepared builder; returns the image or snapshot id. */
  capture: () => Promise<string>
  /** Called however the build ends: Docker removes the builder, Vercel revokes its token. */
  finish: () => Promise<void>
}

/** How one provider builds Workspace bases. */
export type WorkspaceBaseBuilder = {
  provider: RunningSandboxProvider
  /**
   * The agent image the base is built on: the chat image's content id for
   * Docker, the OpenCode version for Vercel. New conversations only start
   * from bases of the current one.
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

/**
 * Docker: a labelled container of the chat image clones and runs setup;
 * `docker commit` makes it an image (labelled with its owners) that
 * conversations start from with stock `dockerSandbox({ image })`.
 */
export function dockerWorkspaceBaseBuilder(input: {
  chatImage: string
  agentImage: string
  cloneToken: string
}): WorkspaceBaseBuilder {
  const docker = new Docker({ timeout: 120_000 })
  return {
    provider: "docker",
    agentImage: input.agentImage,
    cloneToken: input.cloneToken,
    async start(base) {
      const owners = {
        [DOCKER_LABELS.store]: sandboxStoreId(),
        [DOCKER_LABELS.base]: base.id,
        [DOCKER_LABELS.org]: base.orgId,
        [DOCKER_LABELS.workspace]: base.workspaceId,
      }
      const container = await docker.createContainer({
        Image: input.chatImage,
        Cmd: ["sh", "-c", "tail -f /dev/null"],
        WorkingDir: "/workspace",
        Labels: { ...owners, [DOCKER_LABELS.kind]: "workspace-base-builder" },
      })
      const remove = () =>
        removeDockerObject(() => container.remove({ force: true, v: true }))
      try {
        await container.start()
      } catch (error) {
        await remove()
        throw error
      }
      return {
        builderId: container.id,
        handle: new DockerHandle({
          docker,
          container,
          workdir: "/workspace",
          forkFactory: () =>
            Promise.reject(new Error("Base builders never fork")),
          removeOnDestroy: true,
        }),
        capture: async () => {
          const labels = { ...owners, [DOCKER_LABELS.kind]: "workspace-base" }
          const committed = (await container.commit({
            // Tagged, so a dangling-image prune never takes a base in use.
            repo: "ctxpipe-workspace-base",
            tag: base.id.replace(/[^\w.-]/g, "-").slice(0, 128),
            changes: Object.entries(labels).map(
              ([key, value]) => `LABEL ${key}=${JSON.stringify(value)}`,
            ),
          })) as { Id: string }
          return committed.Id
        },
        finish: async () => {
          await remove()
        },
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
      ? ((await getRepoReadCloneToken(input.orgId, appEnv(), {
          githubConnectionId: revision.remote.connectionId ?? undefined,
          repoFullName,
        })) ?? "")
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
          agentSnapshotId: await vercelAgentSnapshot({
            credentials: hosted.credentials,
            environment: hosted.environment,
          }),
          mintGitToken: hosted.mintGitToken,
          backendHost: hosted.backendHost,
          tags: workspaceBaseTags(hosted.environment),
        })
        return {
          builderId: build.name,
          handle: build.handle,
          capture: build.capture,
          finish: build.release,
        }
      },
    }
  }
  return null
}

/** Whether a base's image or snapshot can still start a sandbox. */
export async function workspaceBaseExists(
  provider: string,
  ref: string,
): Promise<boolean> {
  if (provider === "docker")
    return new Docker({ timeout: 30_000 })
      .getImage(ref)
      .inspect()
      .then(
        () => true,
        (error: { statusCode?: number }) => {
          if (error.statusCode === 404) return false
          throw error
        },
      )
  try {
    const snapshot = await Snapshot.get({
      ...(await vercelCredentials()),
      snapshotId: ref,
    })
    return snapshot.status === "created"
  } catch (error) {
    if (error instanceof APIError && error.response.status === 404) return false
    throw error
  }
}

/**
 * Delete what a base row holds at its provider: a builder and the captured
 * image or snapshot. Gone counts as deleted. `in-use`: Docker refuses to
 * delete an image a running container uses (a stopped one keeps working
 * without it, measured), so the row stays for a later sweep.
 */
export async function deleteWorkspaceBaseArtifacts(
  row: Pick<
    SandboxInstanceRecord,
    "provider" | "providerSandboxId" | "latestSnapshotId"
  >,
): Promise<"removed" | "in-use"> {
  if (row.provider === "docker") {
    const docker = new Docker({ timeout: 30_000 })
    const { providerSandboxId: builder, latestSnapshotId: image } = row
    if (builder && builder !== image)
      await removeDockerObject(() =>
        docker.getContainer(builder).remove({ force: true, v: true }),
      )
    return image
      ? removeDockerObject(() => docker.getImage(image).remove({ force: true }))
      : "removed"
  }
  if (row.provider === "vercel") {
    await deleteVercelBuilder({
      credentials: await vercelCredentials(),
      builderName: row.providerSandboxId,
      snapshotId: row.latestSnapshotId,
    })
    return "removed"
  }
  throw new Error(
    `Cannot delete a Workspace base for provider ${row.provider ?? "unknown"}`,
  )
}
