export const OBSERVABILITY_PROJECT_ID = "305aa114-c6f3-4aca-b883-0faa9c331aa2"
export const PRODUCT_PROJECT_ID = "119e3cc3-ef73-43aa-895a-8c8ccff73ff8"

export const OWN_SERVICE_NAME = "railway-telemetry"

export type TelemetryProject = {
  id: string
  fallbackName: string
  collectLogs: boolean
}

export const PROJECTS: readonly TelemetryProject[] = [
  {
    id: OBSERVABILITY_PROJECT_ID,
    fallbackName: "ctxpipe-observability",
    collectLogs: true,
  },
  {
    id: PRODUCT_PROJECT_ID,
    fallbackName: "ctxpipe",
    collectLogs: false,
  },
]

export function deploymentEnvironment(projectId: string, railwayEnvName: string): string {
  if (projectId === OBSERVABILITY_PROJECT_ID) return "observability"
  return railwayEnvName
}

export function includeEnvironment(projectId: string, railwayEnvName: string): boolean {
  if (projectId === OBSERVABILITY_PROJECT_ID) return railwayEnvName === "production"
  if (projectId === PRODUCT_PROJECT_ID) {
    return railwayEnvName === "production" || railwayEnvName.startsWith("pr-")
  }
  return false
}
