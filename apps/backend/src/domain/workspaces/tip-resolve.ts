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

export function shouldEnqueueCronHydrate(input: {
  migrationExportSha: string | null | undefined
  desiredSha?: string | null
  activeProjectionSha?: string | null
  writeStatus?: string | null
}): boolean {
  if (!input.desiredSha) return false
  const skipExportWait =
    input.writeStatus === "read_only" || input.writeStatus === "unknown"
  if (!skipExportWait && !input.migrationExportSha) return false
  return input.desiredSha !== input.activeProjectionSha
}

export function linkedRefMatchesPush(input: {
  webhookRef: string
  desiredRef: string | null
  defaultBranch: string
}): boolean {
  const branch = input.desiredRef?.trim() || input.defaultBranch
  return input.webhookRef === `refs/heads/${branch}`
}

export async function applyResolvedTipsForMatchingWorkspaces(input: {
  repoFullName: string
  defaultBranch: string
  workspaces: ReadonlyArray<{
    id: string
    workspaceRepositoryUrl: string
    desiredGeneration: number
    desiredSha: string | null
  }>
  resolveTip: (fullName: string, ref: string) => Promise<string | null>
  persist: (row: {
    workspaceId: string
    resolvedTip: string
    expectedGeneration: number
    expectedUrl: string
    expectedDesiredSha: string | null
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
      expectedDesiredSha: row.desiredSha,
    })
    if (ok) persisted += 1
  }
  return persisted
}

export async function applyResolvedTipsForMatchingLinked(input: {
  repoFullName: string
  webhookRef: string
  defaultBranch: string
  linked: ReadonlyArray<{
    id: string
    gitUrl: string
    desiredRef: string | null
    desiredSha: string | null
  }>
  resolveTip: (fullName: string, ref: string) => Promise<string | null>
  persist: (row: {
    linkedId: string
    resolvedTip: string
    expectedDesiredSha: string | null
  }) => Promise<boolean>
}): Promise<Array<{ linkedId: string; resolvedTip: string }>> {
  const updated: Array<{ linkedId: string; resolvedTip: string }> = []
  for (const row of input.linked) {
    if (!workspaceMatchesGithubRepo(row.gitUrl, input.repoFullName)) continue
    if (
      !linkedRefMatchesPush({
        webhookRef: input.webhookRef,
        desiredRef: row.desiredRef,
        defaultBranch: input.defaultBranch,
      })
    ) {
      continue
    }
    const branch = row.desiredRef?.trim() || input.defaultBranch
    const tip = await input.resolveTip(input.repoFullName, branch)
    if (!tip) continue
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
    expectedDesiredSha: string | null
  }) => Promise<boolean>
  reloadDesiredSha?: (workspaceId: string) => Promise<string | null>
}): Promise<Array<{ workspaceId: string; resolvedTip: string }>> {
  const updated: Array<{ workspaceId: string; resolvedTip: string }> = []
  for (const row of input.workspaces) {
    let expectedDesiredSha = row.desiredSha
    for (let attempt = 0; attempt < 2; attempt++) {
      const tip = await input.resolveTip(row.workspaceRepositoryUrl)
      if (!tip) break
      if (
        !cronTipCheckNeedsHydrate({
          storedDesiredSha: expectedDesiredSha,
          resolvedTip: tip,
        })
      ) {
        break
      }
      const resolvedTip = desiredShaFromResolvedTip(tip)
      const ok = await input.persist({
        workspaceId: row.id,
        resolvedTip,
        expectedGeneration: row.desiredGeneration,
        expectedUrl: row.workspaceRepositoryUrl,
        expectedDesiredSha,
      })
      if (ok) {
        updated.push({ workspaceId: row.id, resolvedTip })
        break
      }
      if (!input.reloadDesiredSha || attempt === 1) break
      expectedDesiredSha = await input.reloadDesiredSha(row.id)
    }
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
