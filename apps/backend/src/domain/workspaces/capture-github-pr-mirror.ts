import { withOrgIdContext } from "../../auth/withAuth.js"
import type { Env } from "../../config/env.js"
import { getSystemDb } from "../../db/client.js"
import { findOrgGithubRepository } from "../../models/github-pr-mirror.js"
import { readGitPackFromRemote } from "../../services/git/pack.js"
import type { ConnectorMirrorSource } from "./connector-mirror.js"
import { workspaceLinksRepository } from "./connector-mirror.js"
import { resolveWorkspaceReadRevision } from "./resolve-revision.js"

/**
 * Capture the Workspace a linked repository's pull requests are mirrored into.
 * Git decides: the captured tree must still declare the link, so an unlink
 * commit stops new mirrors even before hydrate updates the linked table.
 */
export async function captureGithubPrMirrorTarget(input: {
  orgId: string
  workspaceId: string
  gitUrl: string
  env: Env
}) {
  const org = await getSystemDb().query.organizations.findFirst({
    where: { id: { eq: input.orgId } },
  })
  if (!org) throw new Error("Organization not found")
  return withOrgIdContext(org, async () => {
    const source = await findOrgGithubRepository({
      orgId: input.orgId,
      gitUrl: input.gitUrl,
    })
    if (!source) return { skipped: "no_source" as const }
    const resolved = await resolveWorkspaceReadRevision({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      env: input.env,
      refresh: true,
    })
    if (!resolved) return { skipped: "no_revision" as const }
    const revision = { ...resolved.revision, access: "write-default" as const }
    const pack = await readGitPackFromRemote({
      url: revision.remote.url,
      sha: revision.sha,
      token: resolved.token,
    })
    if (!(await workspaceLinksRepository(pack, input.gitUrl)))
      return { skipped: "unlinked" as const }
    const destination = await findOrgGithubRepository({
      orgId: input.orgId,
      gitUrl: revision.remote.url,
    })
    const mirror: ConnectorMirrorSource = {
      provider: "github",
      connectionId: source.connectionId,
      repositoryId: source.repositoryId,
      configBlobSha: null,
    }
    return {
      revision,
      mirror,
      source,
      /** The Workspace repository's org row, re-indexed after a mirror commit. */
      workspaceRepositoryId: destination?.repositoryId ?? null,
    }
  })
}
