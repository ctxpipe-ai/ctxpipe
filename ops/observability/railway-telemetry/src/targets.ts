export const OBSERVABILITY_PROJECT_ID = "305aa114-c6f3-4aca-b883-0faa9c331aa2"
export const PRODUCT_PROJECT_ID = "119e3cc3-ef73-43aa-895a-8c8ccff73ff8"

export const PROJECT_IDS = [OBSERVABILITY_PROJECT_ID, PRODUCT_PROJECT_ID] as const

export function deploymentEnvironment(projectId: string, railwayEnvName: string): string {
  return projectId === OBSERVABILITY_PROJECT_ID ? "observability" : railwayEnvName
}

/** Observability production, product production, and product preview environments. */
export function includeEnvironment(projectId: string, railwayEnvName: string): boolean {
  if (projectId === OBSERVABILITY_PROJECT_ID) return railwayEnvName === "production"
  if (projectId === PRODUCT_PROJECT_ID) {
    return railwayEnvName === "production" || railwayEnvName.startsWith("pr-")
  }
  return false
}
