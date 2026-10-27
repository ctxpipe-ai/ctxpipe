import { basename } from "node:path"

import {
  type ConnectorAssetBudget,
  type ConnectorAssetBytePool,
  connectorAssetCommitFile,
  consumeConnectorAssetBytePool,
  downloadConnectorAsset,
} from "../connectors/assets.js"
import type { CommitFile } from "../github/installation-write-client.js"
import {
  type PagerdutyIncidentForMirror,
  pagerdutyAlertAssetCandidates,
  pagerdutyIncidentAssetLink,
  pagerdutyIncidentImageStub,
  pagerdutyIncidentMirrorFiles,
  rewritePagerdutyIncidentImageSrcs,
} from "./converter.js"

export async function capturePagerdutyIncidentAssets(input: {
  incident: PagerdutyIncidentForMirror
  budget: ConnectorAssetBudget
  bytePool?: ConnectorAssetBytePool
  /** The incident folder. Default: the legacy `pagerduty/incidents/`. */
  root?: string
}): Promise<{
  files: CommitFile[]
  preservePathPrefixes: string[]
}> {
  const files: CommitFile[] = pagerdutyIncidentMirrorFiles(
    input.incident,
    input.root,
  ).map((file) => ({
    path: file.path,
    content: file.content,
  }))
  const markdown = files.find((file) => file.path.endsWith(".md"))
  const preservePathPrefixes: string[] = []

  for (const candidate of pagerdutyAlertAssetCandidates(
    input.incident,
    input.root,
  )) {
    const downloaded = await downloadConnectorAsset({
      url: candidate.sourceUrl,
      budget: input.budget,
      filename: basename(candidate.filename),
    })
    if (
      downloaded.status === "downloaded" &&
      (input.bytePool === undefined ||
        consumeConnectorAssetBytePool(
          input.bytePool,
          downloaded.bytes.byteLength,
        ))
    ) {
      files.push(connectorAssetCommitFile(candidate.filename, downloaded.bytes))
      if (markdown && markdown.encoding !== "base64") {
        markdown.content = rewritePagerdutyIncidentImageSrcs(markdown.content, [
          {
            sourceUrl: candidate.sourceUrl,
            relativePath: pagerdutyIncidentAssetLink(
              input.incident.number,
              input.incident.id,
              candidate.filename,
            ),
          },
        ])
      }
      continue
    }
    preservePathPrefixes.push(candidate.filename)
    if (markdown && markdown.encoding !== "base64") {
      markdown.content = markdown.content
        .split(`![${candidate.label}](${candidate.sourceUrl})`)
        .join(
          pagerdutyIncidentImageStub(candidate.label, input.incident.htmlUrl),
        )
    }
  }
  return { files, preservePathPrefixes }
}
