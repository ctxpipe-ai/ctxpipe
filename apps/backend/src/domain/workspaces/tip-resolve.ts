import { applyResolvedDesiredSha } from "./revision.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

export function isDefaultBranchPush(
  ref: string,
  defaultBranch: string,
): boolean {
  return ref === `refs/heads/${defaultBranch}`
}

/** Webhook `after` is a trigger only. Persist the resolved tip. */
export function desiredShaFromResolvedTip(
  resolvedTip: string,
  _payloadAfter?: string,
): string {
  return applyResolvedDesiredSha(resolvedTip)
}

export function workspaceMatchesGithubRepo(
  workspaceRepositoryUrl: string,
  repoFullName: string,
): boolean {
  const fullName = githubRepoFullNameFromWorkspaceUrl(workspaceRepositoryUrl)
  return fullName?.toLowerCase() === repoFullName.toLowerCase()
}

export function cronTipCheckNeedsHydrate(input: {
  storedDesiredSha: string | null
  resolvedTip: string
}): boolean {
  return input.storedDesiredSha !== applyResolvedDesiredSha(input.resolvedTip)
}

export async function applyResolvedTipsForMatchingWorkspaces(input: {
  repoFullName: string
  defaultBranch: string
  workspaces: ReadonlyArray<{
    id: string
    workspaceRepositoryUrl: string
    desiredGeneration: number
  }>
  resolveTip: (fullName: string, ref: string) => Promise<string | null>
  persist: (row: {
    workspaceId: string
    resolvedTip: string
    expectedGeneration: number
    expectedUrl: string
  }) => Promise<boolean>
}): Promise<number> {
  let persisted = 0
  for (const row of input.workspaces) {
    if (
      !workspaceMatchesGithubRepo(
        row.workspaceRepositoryUrl,
        input.repoFullName,
      )
    ) {
      continue
    }
    const tip = await input.resolveTip(input.repoFullName, input.defaultBranch)
    if (!tip) continue
    const ok = await input.persist({
      workspaceId: row.id,
      resolvedTip: desiredShaFromResolvedTip(tip),
      expectedGeneration: row.desiredGeneration,
      expectedUrl: row.workspaceRepositoryUrl,
    })
    if (ok) persisted += 1
  }
  return persisted
}
