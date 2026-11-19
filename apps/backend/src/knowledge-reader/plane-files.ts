import { eq } from "drizzle-orm"

import { parseEnv } from "../config/env.js"
import { withOrgDbContext } from "../db/client.js"
import { workspaces } from "../db/schema/workspaces.js"
import {
  type HydrateUnit,
  hydrateKnowledgeTree,
  servingIdForKnowledgePath,
} from "../domain/workspaces/hydrate.js"
import { resolveRepositoryReadCredential } from "../domain/workspaces/resolve-revision.js"
import { workspaceRevisionSchema } from "../domain/workspaces/revision.js"
import {
  workspaceRepositoryPath,
  workspaceRootPath,
} from "../domain/workspaces/root-path.js"
import { McpToolError } from "../mcp/framework/tool-errors.js"
import { log } from "../observability/logger.js"
import {
  listMarkdownFilesAtGitSha,
  readFileAtGitSha,
} from "../services/git/clone-tree.js"
import { knowledgeStore } from "./plane-reader.js"

/*
 * The file reads of `read_file` and `list_files` on the knowledge plane
 * (CTX-1409). The plane keeps chunks, not full bodies, and Git is the source
 * of truth (ADR-067). Thus the text comes from the Workspace repository at
 * the SHA that the plane serves (`knowledge_state.last_sha`). The hydrate
 * parse decides which files are units, as on the old stack.
 */

/** A unit of the Workspace Git at the plane SHA. */
export type PlaneUnit = {
  unit: HydrateUnit
  /** The time that the plane observed the document; the plane results show it as `updatedAt`. */
  observedAt: Date
}

/** A unit file of a folder listing, with its size in bytes. */
export type PlaneUnitFile = { path: string; size: number }

/** The remote, its read token and the root folder of the Workspace repository. */
async function workspaceRepository(orgId: string, workspaceId: string) {
  const [row] = await withOrgDbContext(orgId, (db) =>
    db
      .select({ activeRevision: workspaces.activeRevision })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1),
  )
  const revision = workspaceRevisionSchema.safeParse(row?.activeRevision)
  if (!revision.success)
    throw new Error("A Workspace on the knowledge plane has no revision")
  const token = await resolveRepositoryReadCredential({
    orgId,
    env: parseEnv(process.env),
    remote: revision.data.remote,
  })
  return {
    url: revision.data.remote.url,
    token,
    root: workspaceRootPath(revision.data),
  }
}

/** Run a Git read; a failure of the Git host is a retryable tool error. */
async function gitRead<T>(
  step: string,
  workspaceId: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read()
  } catch (error) {
    log.warn({
      step,
      workspaceId,
      message: error instanceof Error ? error.message : String(error),
    })
    throw new McpToolError(
      "internal",
      "The Workspace repository is not available at the moment. Try again.",
    )
  }
}

/**
 * The unit at `path` in the Workspace Git at `sha`, or null when the file is
 * not there, is not a unit, or the plane has no active document for it.
 */
export async function readPlaneUnit(input: {
  orgId: string
  workspaceId: string
  sha: string
  /** The path from the Workspace root. */
  path: string
}): Promise<PlaneUnit | null> {
  const { orgId, workspaceId, sha, path } = input
  const repository = await workspaceRepository(orgId, workspaceId)
  const docKey = servingIdForKnowledgePath(workspaceId, path)
  const [file, documents] = await gitRead(
    "mcp.read_file.git_failed",
    workspaceId,
    () =>
      Promise.all([
        readFileAtGitSha({
          url: repository.url,
          sha,
          path: workspaceRepositoryPath(repository.root, path),
          token: repository.token,
          treesOnly: true,
        }),
        knowledgeStore().readDocuments({ orgId, workspaceIds: [workspaceId] }, [
          { workspaceId, docKey },
        ]),
      ]),
  )
  const document = documents[0]?.document
  if (file.kind === "missing" || document?.status !== "active") return null
  const [unit] = hydrateKnowledgeTree({
    workspaceId,
    files: [{ path, content: Buffer.from(file.bytes).toString("utf8") }],
  }).units
  return unit ? { unit, observedAt: document.observedAt } : null
}

/** The unit files below `folder` (`""` is the root) in the Workspace Git at `sha`. */
export async function listPlaneUnitFiles(input: {
  orgId: string
  workspaceId: string
  sha: string
  folder: string
}): Promise<PlaneUnitFile[]> {
  const { orgId, workspaceId, sha, folder } = input
  const repository = await workspaceRepository(orgId, workspaceId)
  const files = await gitRead("mcp.list_files.git_failed", workspaceId, () =>
    listMarkdownFilesAtGitSha({
      url: repository.url,
      sha,
      token: repository.token,
      root: repository.root,
      ...(folder ? { prefix: `${folder}/` } : {}),
    }),
  )
  const sizes = new Map(
    files.map((file) => [file.path, Buffer.byteLength(file.content)]),
  )
  return hydrateKnowledgeTree({ workspaceId, files }).units.map((unit) => ({
    path: unit.path,
    size: sizes.get(unit.path) ?? 0,
  }))
}
