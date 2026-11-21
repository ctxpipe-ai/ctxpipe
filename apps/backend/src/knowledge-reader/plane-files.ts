import { eq } from "drizzle-orm"

import { parseEnv } from "../config/env.js"
import { withOrgDbContext } from "../db/client.js"
import { workspaces } from "../db/schema/workspaces.js"
import {
  SOURCES_FOLDER_PREFIX,
  SOURCES_TREE_READ,
  splitSourcesTree,
} from "../domain/workspace-sources/source-tree.js"
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
import type { KnowledgeHead } from "../models/knowledge-state.js"
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

/** A unit file of a folder listing, with the size of its body in bytes. */
export type UnitFile = { path: string; size: number }

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
 * not there or is not a unit. `updatedAt` is the time that the plane
 * observed the document, as in the other results of the plane; without a
 * document row it is the time of the read.
 */
export async function readPlaneUnit(input: {
  orgId: string
  workspaceId: string
  /** The head that the plane serves: Git is read at its SHA. */
  head: KnowledgeHead
  /** The path from the Workspace root. */
  path: string
}): Promise<{ unit: HydrateUnit; updatedAt: Date } | null> {
  const { orgId, workspaceId, head, path } = input
  const { sha } = head
  const repository = await workspaceRepository(orgId, workspaceId)
  // The `CHANGED` and `FROM_SOURCE` claims of a unit come from the files
  // under `sources/`, so the parse gets them too, as the hydrate does.
  const [file, sourcesTree] = await gitRead(
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
        listMarkdownFilesAtGitSha({
          ...SOURCES_TREE_READ,
          prefix: SOURCES_FOLDER_PREFIX,
          url: repository.url,
          sha,
          token: repository.token,
          root: repository.root,
        }),
      ]),
  )
  if (file.kind === "missing") return null
  const sources = splitSourcesTree(sourcesTree)
  const unit = hydrateKnowledgeTree({
    workspaceId,
    workspaceUrl: repository.url,
    files: [
      { path, content: Buffer.from(file.bytes).toString("utf8") },
      ...sources.files.filter((source) => source.path !== path),
    ],
    sourceFiles: sources.sourceFiles,
  }).units.find((parsed) => parsed.path === path)
  if (!unit) return null
  const [document] = await knowledgeStore().readDocuments(
    {
      orgId,
      heads: [{ workspaceId, ...head }],
    },
    [{ workspaceId, docKey: servingIdForKnowledgePath(workspaceId, path) }],
  )
  return { unit, updatedAt: document?.document.observedAt ?? new Date() }
}

/** The unit files below `folder` (`""` is the root) in the Workspace Git at `sha`. */
export async function listPlaneUnitFiles(input: {
  orgId: string
  workspaceId: string
  sha: string
  folder: string
}): Promise<UnitFile[]> {
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
  return hydrateKnowledgeTree({ workspaceId, files }).units.map((unit) => ({
    path: unit.path,
    size: Buffer.byteLength(unit.body),
  }))
}
