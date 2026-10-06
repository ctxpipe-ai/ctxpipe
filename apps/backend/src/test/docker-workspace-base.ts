import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import Docker from "dockerode"
import { eq } from "drizzle-orm"
import { withOrgDbContext } from "../db/client.js"
import { conversations } from "../db/schema/conversations.js"
import {
  workspaceSandboxInstances,
  workspaces,
} from "../db/schema/workspaces.js"
import { warmTanstackWorkspaceChat } from "../domain/workspaces/tanstack-workspace-chat.js"
import {
  dockerWorkspaceBaseBuilder,
  sandboxAgentImage,
  type WorkspaceBaseBuilder,
} from "../domain/workspaces/workspace-base-providers.js"
import {
  reserveWorkspaceBaseBuild,
  runWorkspaceBaseBuild,
} from "../domain/workspaces/workspace-sandbox-base.js"
import { collectUnusedWorkspaceBases } from "../domain/workspaces/workspace-sandbox-cleanup.js"
import { generateObjectId } from "../lib/id.js"
import { listSandboxInstances } from "../models/workspaces.js"
import type { withNativeChatFixture } from "./native-chat-fixture.js"

/*
 * Docker Workspace bases for a native chat fixture. The Workspace base
 * contract test and the time-to-ready script use it.
 */

const exec = promisify(execFile)
const docker = new Docker({ timeout: 60_000 })

export const CHAT_IMAGE =
  process.env.CTXPIPE_TEST_CHAT_SANDBOX_IMAGE?.trim() ||
  "ctxpipe-chat-sandbox:opencode-1.18.34"
/** Stands in for a minted GitHub read token; must never land in a base. */
export const TOKEN = `ghs_fixture${randomUUID().replaceAll("-", "")}`

export type Fixture = Parameters<Parameters<typeof withNativeChatFixture>[0]>[0]

/** Docker conversations and bases for one fixture Workspace served by `remote`. */
export function dockerChat(f: Fixture, remoteUrl: string) {
  const conversation = async () => {
    const id = generateObjectId("conv")
    await withOrgDbContext(f.orgId, (db) =>
      db
        .insert(conversations)
        .values({ id, orgId: f.orgId, workspaceId: f.workspaceId }),
    )
    return id
  }
  const warm = async (conversationId: string, sha: string) => {
    const started = Date.now()
    const warmed = await warmTanstackWorkspaceChat({
      conversationId,
      orgId: f.orgId,
      orgSlug: f.orgSlug,
      workspaceId: f.workspaceId,
      desiredUrl: remoteUrl,
      desiredSha: sha,
      defaultBranch: "main",
      writeStatus: "read_only",
      prompt: "prepare",
      cloneToken: TOKEN,
    })
    if (!warmed.ok) throw new Error(`prepare failed: ${warmed.error}`)
    return { handle: warmed.handle, ms: Date.now() - started }
  }
  const bases = async () =>
    withOrgDbContext(f.orgId, () =>
      listSandboxInstances({ workspaceId: f.workspaceId, kind: "base" }),
    )
  const agent = async () => ({
    provider: "docker" as const,
    image: await sandboxAgentImage("docker"),
  })
  const builder = async (): Promise<WorkspaceBaseBuilder> =>
    dockerWorkspaceBaseBuilder({ chatImage: CHAT_IMAGE, cloneToken: TOKEN })
  const reserve = async (runId = randomUUID()) =>
    reserveWorkspaceBaseBuild({
      orgId: f.orgId,
      workspaceId: f.workspaceId,
      runId,
      agent: await agent(),
    })
  const run = async (
    baseId: string,
    wrap?: (b: WorkspaceBaseBuilder) => WorkspaceBaseBuilder,
  ) => {
    const plain = await builder()
    return runWorkspaceBaseBuild({
      orgId: f.orgId,
      baseId,
      builder: wrap ? wrap(plain) : plain,
    })
  }
  /** The base workflow's two steps, in order. */
  const build = async (
    wrap?: (b: WorkspaceBaseBuilder) => WorkspaceBaseBuilder,
  ) => {
    const baseId = await reserve()
    return baseId ? run(baseId, wrap) : null
  }
  const collect = async (now = new Date()) =>
    collectUnusedWorkspaceBases({
      orgId: f.orgId,
      workspaceId: f.workspaceId,
      agent: await agent(),
      now,
    })
  const head = async (handle: {
    process: { exec: (command: string) => Promise<{ stdout: string }> }
  }) => (await handle.process.exec("git rev-parse HEAD")).stdout.trim()
  const imageOf = async (containerId: string) =>
    (await docker.getContainer(containerId).inspect()).Image
  const setDesired = (sha: string) =>
    withOrgDbContext(f.orgId, (db) =>
      db
        .update(workspaces)
        .set({ desiredSha: sha })
        .where(eq(workspaces.id, f.workspaceId)),
    )
  const commit = async (text: string) => {
    await writeFile(join(f.directory, "README.md"), text)
    await exec("git", [
      "-C",
      f.directory,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-am",
      text,
    ])
    return (
      await exec("git", ["-C", f.directory, "rev-parse", "HEAD"])
    ).stdout.trim()
  }
  const backdateBases = () =>
    withOrgDbContext(f.orgId, (db) =>
      db
        .update(workspaceSandboxInstances)
        .set({ createdAt: new Date(Date.now() - 25 * 60 * 60_000) })
        .where(eq(workspaceSandboxInstances.kind, "base")),
    )
  return {
    conversation,
    warm,
    bases,
    agent,
    builder,
    reserve,
    run,
    build,
    collect,
    head,
    imageOf,
    setDesired,
    commit,
    backdateBases,
  }
}
