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

export async function runCronTipChecks(input: {
  workspaces: ReadonlyArray<{
    id: string
    workspaceRepositoryUrl: string
    desiredGeneration: number
    desiredSha: string | null
  }>
  resolveTip: (workspaceRepositoryUrl: string) => Promise<string | null>
  persist: (row: {
    workspaceId: string
    resolvedTip: string
    expectedGeneration: number
    expectedUrl: string
  }) => Promise<boolean>
}): Promise<string[]> {
  const updated: string[] = []
  for (const row of input.workspaces) {
    const tip = await input.resolveTip(row.workspaceRepositoryUrl)
    if (!tip) continue
    if (
      !cronTipCheckNeedsHydrate({
        storedDesiredSha: row.desiredSha,
        resolvedTip: tip,
      })
    ) {
      continue
    }
    const ok = await input.persist({
      workspaceId: row.id,
      resolvedTip: desiredShaFromResolvedTip(tip),
      expectedGeneration: row.desiredGeneration,
      expectedUrl: row.workspaceRepositoryUrl,
    })
    if (ok) updated.push(row.id)
  }
  return updated
}

export async function runCronLinkedTipChecks(input: {
  linked: ReadonlyArray<{
    id: string
    workspaceId: string
    gitUrl: string
    desiredRef: string | null
    desiredSha: string | null
  }>
  resolveTip: (
    gitUrl: string,
    desiredRef: string | null,
  ) => Promise<string | null>
  persist: (row: {
    linkedId: string
    resolvedTip: string
    expectedDesiredSha: string | null
  }) => Promise<boolean>
}): Promise<Array<{ linkedId: string; resolvedTip: string }>> {
  const updated: Array<{ linkedId: string; resolvedTip: string }> = []
  for (const row of input.linked) {
    const tip = await input.resolveTip(row.gitUrl, row.desiredRef)
    if (!tip) continue
    if (
      !cronTipCheckNeedsHydrate({
        storedDesiredSha: row.desiredSha,
        resolvedTip: tip,
      })
    ) {
      continue
    }
    const resolvedTip = desiredShaFromResolvedTip(tip)
    const ok = await input.persist({
      linkedId: row.id,
      resolvedTip,
      expectedDesiredSha: row.desiredSha,
    })
    if (ok) updated.push({ linkedId: row.id, resolvedTip })
  }
  return updated
}
