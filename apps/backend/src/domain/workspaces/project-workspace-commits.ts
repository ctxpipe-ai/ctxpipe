import type { Env } from "../../config/env.js"
import {
  getWorkspaceCommitProjection,
  insertWorkspaceRepositoryCommits,
  listWorkspaceCommitShas,
  pruneWorkspaceRepositoryCommits,
  upsertWorkspaceCommitProjection,
} from "../../models/workspace-commits.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import {
  activityCalendarStart,
  shouldSkipCommitProjection,
} from "./commit-activity.js"
import { fetchGithubWorkspaceCommits } from "./fetch-github-commits.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

export async function projectWorkspaceCommits(input: {
  workspaceId: string
  env: Env
}): Promise<{ status: "ready" | "failed" | "skipped" }> {
  const workspace = await getWorkspaceById(input.workspaceId)
  if (!workspace) return { status: "skipped" }

  const projection = await getWorkspaceCommitProjection(workspace.id)
  if (
    shouldSkipCommitProjection({
      headSha: projection?.headSha ?? null,
      desiredSha: workspace.desiredSha,
      status: projection?.backfillStatus ?? "pending",
    })
  ) {
    return { status: "skipped" }
  }

  if (!githubRepoFullNameFromWorkspaceUrl(workspace.workspaceRepositoryUrl)) {
    await upsertWorkspaceCommitProjection({
      workspaceId: workspace.id,
      headSha: workspace.desiredSha,
      backfillStatus: "ready",
      backfilledSince: activityCalendarStart(),
    })
    return { status: "ready" }
  }

  await upsertWorkspaceCommitProjection({
    workspaceId: workspace.id,
    headSha: projection?.headSha ?? null,
    backfillStatus: "pending",
    backfilledSince: projection?.backfilledSince ?? activityCalendarStart(),
  })

  const existingShas = await listWorkspaceCommitShas(workspace.id)
  const fetched = await fetchGithubWorkspaceCommits({
    orgId: workspace.orgId,
    githubConnectionId: workspace.githubConnectionId,
    workspaceRepositoryUrl: workspace.workspaceRepositoryUrl,
    since: activityCalendarStart(),
    existingShas,
    env: input.env,
  })
  if (!fetched.ok) {
    await upsertWorkspaceCommitProjection({
      workspaceId: workspace.id,
      headSha: projection?.headSha ?? null,
      backfillStatus: "failed",
      backfilledSince: projection?.backfilledSince ?? null,
    })
    return { status: "failed" }
  }

  await insertWorkspaceRepositoryCommits({
    workspaceId: workspace.id,
    commits: fetched.commits,
  })
  await pruneWorkspaceRepositoryCommits(workspace.id)
  await upsertWorkspaceCommitProjection({
    workspaceId: workspace.id,
    headSha: workspace.desiredSha,
    backfillStatus: "ready",
    backfilledSince: activityCalendarStart(),
  })
  return { status: "ready" }
}
