import type { NotionResource } from "./types"

type SetupStatus = {
  setupPhase: string
  selectedResourceCount: number
}

function scopeKeys(resources: NotionResource[]): string[] {
  return resources
    .map((resource) => `${resource.type}:${resource.externalId}`)
    .sort()
}

export function hasNotionScopeChanged(
  saved: NotionResource[],
  selected: NotionResource[],
): boolean {
  return (
    JSON.stringify(scopeKeys(saved)) !== JSON.stringify(scopeKeys(selected))
  )
}

export function shouldShowNotionSetupComplete(
  status: SetupStatus,
  manageScope: boolean,
): boolean {
  return (
    !manageScope &&
    status.setupPhase === "live" &&
    status.selectedResourceCount > 0
  )
}
