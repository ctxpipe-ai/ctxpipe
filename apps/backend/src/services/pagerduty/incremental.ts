import type { Env } from "../../config/env.js"
import type { PagerdutyConnection } from "../../models/pagerduty-connector.js"
import {
  type ConnectorAssetBudget,
  connectorPathMatchesPreservation,
} from "../connectors/assets.js"
import type { CommitFile } from "../github/installation-write-client.js"
import { getPagerdutyIncident } from "./client.js"
import type { ParsedPagerdutyRepoConfig } from "./config-yaml.js"
import {
  type PagerdutyIncidentForMirror,
  pagerdutyIncidentAssetDir,
  pagerdutyIncidentMirrorFiles,
  pagerdutyManagedPathsForIncidentId,
} from "./converter.js"
import { capturePagerdutyIncidentAssets } from "./sync-assets.js"

export type PagerdutyEntityChange = {
  incidentId: string
}

export type PagerdutyIncrementalChanges = {
  files: CommitFile[]
  deletePaths: string[]
  failures: Array<{ id: string; message: string }>
}

function scopedServiceIds(config: ParsedPagerdutyRepoConfig): Set<string> {
  return new Set(config.services.map((service) => service.id))
}

export function pagerdutyIncidentIsInScope(
  incident: Pick<PagerdutyIncidentForMirror, "serviceId">,
  config: ParsedPagerdutyRepoConfig,
): boolean {
  return scopedServiceIds(config).has(incident.serviceId)
}

export async function buildPagerdutyIncrementalChanges(input: {
  env: Env
  connection: PagerdutyConnection
  config: ParsedPagerdutyRepoConfig
  entity: PagerdutyEntityChange
  existingPaths: string[]
  budget: ConnectorAssetBudget
}): Promise<PagerdutyIncrementalChanges> {
  const priorPaths = pagerdutyManagedPathsForIncidentId(
    input.existingPaths,
    input.entity.incidentId,
  )

  if (!input.connection.accessToken) {
    throw new Error("PagerDuty connection has no access token")
  }
  const incident = await getPagerdutyIncident({
    accessToken: input.connection.accessToken,
    region: input.connection.region,
    incidentId: input.entity.incidentId,
  })
  if (incident === "not_found") {
    return { files: [], deletePaths: priorPaths, failures: [] }
  }
  if (!pagerdutyIncidentIsInScope(incident, input.config)) {
    return { files: [], deletePaths: priorPaths, failures: [] }
  }

  const captured = await capturePagerdutyIncidentAssets({
    incident,
    budget: input.budget,
  })
  const desired = new Set(captured.files.map((file) => file.path))
  return {
    files: captured.files,
    deletePaths: priorPaths.filter(
      (path) =>
        !desired.has(path) &&
        !captured.preservePathPrefixes.some((prefix) =>
          connectorPathMatchesPreservation(path, prefix),
        ),
    ),
    failures: [],
  }
}

export { pagerdutyIncidentAssetDir, pagerdutyIncidentMirrorFiles }
