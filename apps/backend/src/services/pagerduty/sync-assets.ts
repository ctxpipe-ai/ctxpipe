import { basename } from "node:path"
import {
  type ConnectorAssetBudget,
  connectorAssetCommitFile,
  downloadConnectorAsset,
} from "../connectors/assets.js"
import type { CommitFile } from "../github/installation-write-client.js"
import {
  pagerdutyAlertAssetCandidates,
  pagerdutyIncidentMirrorFiles,
  type PagerdutyIncidentForMirror,
} from "./converter.js"

export async function capturePagerdutyIncidentAssets(input: {
  incident: PagerdutyIncidentForMirror
  budget: ConnectorAssetBudget
}): Promise<{
  files: CommitFile[]
  replacements: Array<{ sourceUrl: string; relativePath: string }>
}> {
  const files: CommitFile[] = pagerdutyIncidentMirrorFiles(input.incident).map(
    (file) => ({
      path: file.path,
      content: file.content,
    }),
  )
  const replacements: Array<{ sourceUrl: string; relativePath: string }> = []
  for (const candidate of pagerdutyAlertAssetCandidates(input.incident)) {
    const downloaded = await downloadConnectorAsset({
      url: candidate.sourceUrl,
      budget: input.budget,
      filename: basename(candidate.filename),
    })
    if (downloaded.status !== "downloaded") continue
    files.push(connectorAssetCommitFile(candidate.filename, downloaded.bytes))
    replacements.push({
      sourceUrl: candidate.sourceUrl,
      relativePath: `./${input.incident.number}--${input.incident.id}/assets/${basename(candidate.filename)}`,
    })
  }
  return { files, replacements }
}
