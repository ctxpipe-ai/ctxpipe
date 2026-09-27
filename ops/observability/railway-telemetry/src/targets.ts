export const PRODUCT_PROJECT_ID = "119e3cc3-ef73-43aa-895a-8c8ccff73ff8"

function observabilityProjectId(): string {
  const id = process.env.RAILWAY_PROJECT_ID?.trim()
  if (!id) throw new Error("RAILWAY_PROJECT_ID is required")
  return id
}

export function projectIds(): readonly [string, string] {
  return [observabilityProjectId(), PRODUCT_PROJECT_ID]
}

export function isObservabilityProject(projectId: string): boolean {
  return projectId === observabilityProjectId()
}

export function deploymentEnvironment(projectId: string, railwayEnvName: string): string {
  return isObservabilityProject(projectId) ? "observability" : railwayEnvName
}

/** Observability production, product production, and product preview environments. */
export function includeEnvironment(projectId: string, railwayEnvName: string): boolean {
  if (isObservabilityProject(projectId)) return railwayEnvName === "production"
  if (projectId === PRODUCT_PROJECT_ID) {
    return railwayEnvName === "production" || railwayEnvName.startsWith("pr-")
  }
  return false
}
