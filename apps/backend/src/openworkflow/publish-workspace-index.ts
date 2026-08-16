import { withOrgIdContext } from "../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../db/client.js"
import { getRepository } from "../models/repositories.js"
import { publishWorkspaceIndexForGitUrl } from "../models/workspaces.js"

export async function publishWorkspaceIndexAfterCodesearch(input: {
  orgId: string
  repositoryId: string
  indexedSha: string
}): Promise<number> {
  const org = await getSystemDb().query.organizations.findFirst({
    where: { id: { eq: input.orgId } },
  })
  if (!org) return 0
  return withOrgIdContext({ id: org.id, slug: org.slug }, () =>
    withOrgDbContext(input.orgId, async () => {
      const repo = await getRepository(input.repositoryId)
      if (!repo) return 0
      return publishWorkspaceIndexForGitUrl({
        gitUrl: repo.gitUrl,
        indexedSha: input.indexedSha,
      })
    }),
  )
}
