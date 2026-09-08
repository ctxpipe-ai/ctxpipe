import { requireCurrentOrgId } from "../../auth/context.js"
import { parseEnv } from "../../config/env.js"
import {
  listPathsAtGitSha,
  readFileAtGitSha,
} from "../../services/git/clone-tree.js"
import type { ExplorerGitFile } from "./git-explorer.js"
import { resolveRepositoryReadCredential } from "./resolve-revision.js"
import { type WorkspaceRevision, workspaceRevisionSchema } from "./revision.js"

export class WorkspaceCheckoutReadError extends Error {
  override readonly name = "WorkspaceCheckoutReadError"

  constructor(
    message: string,
    readonly status: 404 | 409 | 502,
  ) {
    super(message)
  }
}

async function repositoryReadInput(revision: WorkspaceRevision) {
  workspaceRevisionSchema.parse(revision)
  if (revision.access !== "read")
    throw new WorkspaceCheckoutReadError(
      "A published read revision is required",
      409,
    )
  return {
    url: revision.remote.url,
    sha: revision.sha,
    token: await resolveRepositoryReadCredential({
      orgId: requireCurrentOrgId(),
      env: parseEnv(process.env),
      remote: revision.remote,
    }),
  }
}

export async function listWorkspaceCheckoutPaths(input: {
  revision: WorkspaceRevision
}): Promise<string[]> {
  return listPathsAtGitSha(await repositoryReadInput(input.revision))
}

export async function readWorkspaceCheckoutFile(input: {
  revision: WorkspaceRevision
  path: string
}): Promise<ExplorerGitFile> {
  return readFileAtGitSha({
    ...(await repositoryReadInput(input.revision)),
    path: input.path,
  })
}
