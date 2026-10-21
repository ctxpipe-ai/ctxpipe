import type { Env } from "../../config/env.js"
import { readFileAtGitSha } from "../../services/git/clone-tree.js"
import {
  type GitPack,
  type GitRemoteRead,
  readGitFiles,
} from "../../services/git/pack.js"
import { workspaceRepositoryPath } from "../../services/git/root-folder.js"
import { resolveRepositoryReadCredential } from "./resolve-revision.js"
import type { WorkspaceRevision } from "./revision.js"
import { workspaceRootPath } from "./root-path.js"
import {
  readWorkspaceFormat,
  WORKSPACE_FORMAT_PATH,
  workspaceFormatCacheValue,
} from "./workspace-format.js"

/*
 * Read the Workspace format from git, not from the `format_version` cache.
 * A write path that depends on the format reads the tree that it writes on
 * (ADR-053). The value is the cache value: 0 for no file, -1 for a file that
 * is not valid.
 */

/** The format in a pack of the Workspace tree. Pack paths are relative to the root folder. */
export async function packWorkspaceFormat(
  pack: GitPack,
  read?: GitRemoteRead,
): Promise<number> {
  const [file] = await readGitFiles(
    pack,
    (path) => path === WORKSPACE_FORMAT_PATH,
    undefined,
    read,
  )
  return workspaceFormatCacheValue(readWorkspaceFormat(file?.content ?? null))
}

/** The format at one commit of the Workspace repository. */
export async function readWorkspaceFormatAt(input: {
  orgId: string
  env: Env
  revision: Pick<WorkspaceRevision, "remote" | "rootPath" | "sha">
}): Promise<number> {
  const token = await resolveRepositoryReadCredential({
    orgId: input.orgId,
    env: input.env,
    remote: input.revision.remote,
  })
  const file = await readFileAtGitSha({
    url: input.revision.remote.url,
    sha: input.revision.sha,
    path: workspaceRepositoryPath(
      workspaceRootPath(input.revision),
      WORKSPACE_FORMAT_PATH,
    ),
    token,
  })
  return workspaceFormatCacheValue(
    readWorkspaceFormat(
      file.kind === "bytes" ? Buffer.from(file.bytes).toString("utf8") : null,
    ),
  )
}
