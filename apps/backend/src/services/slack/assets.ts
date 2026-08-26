import type { ConnectorAssetBudget } from "../connectors/assets.js"
import {
  CONNECTOR_ENTITY_MAX_ASSETS,
  connectorAssetCommitFile,
  connectorBlobUnchanged,
  createConnectorAssetBudget,
  downloadConnectorAsset,
} from "../connectors/assets.js"
import type { CommitFile } from "../github/installation-write-client.js"
import {
  type SlackCaptureAssetLink,
  type SlackCollectedMedia,
  slackAssetKind,
} from "./converter.js"

function isSlackTrustedAssetHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return (
    host === "files.slack.com" ||
    host.endsWith(".files.slack.com") ||
    host === "files-origin.slack.com" ||
    host === "slack-files.com" ||
    (host.endsWith(".slack.com") && host.startsWith("files"))
  )
}

function authenticatedHostsFor(url: string): string[] {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (!isSlackTrustedAssetHost(host)) return []
    return [
      ...new Set([
        host,
        "files.slack.com",
        "files-origin.slack.com",
        "slack-files.com",
      ]),
    ]
  } catch {
    return []
  }
}

function stubPath(media: SlackCollectedMedia): string {
  return media.permalink?.trim() || ""
}

export function slackManagedPathsForThread(
  paths: string[],
  threadDir: string,
): string[] {
  const prefix = threadDir.endsWith("/") ? threadDir : `${threadDir}/`
  return paths.filter(
    (path) =>
      path === `${prefix}index.md` ||
      path === `${prefix}thread.md` ||
      path.startsWith(`${prefix}assets/`),
  )
}

export async function captureSlackThreadAssets(input: {
  threadDir: string
  botToken: string
  media: SlackCollectedMedia[]
  existing?: Array<{ path: string; sha: string }>
  budget?: ConnectorAssetBudget
}): Promise<{
  files: CommitFile[]
  linksBySourceKey: Map<string, SlackCaptureAssetLink>
  keptPaths: string[]
}> {
  const budget = input.budget ?? createConnectorAssetBudget()
  const existingByPath = new Map(
    (input.existing ?? []).map((file) => [file.path, file.sha]),
  )
  const files: CommitFile[] = []
  const keptPaths: string[] = []
  const linksBySourceKey = new Map<string, SlackCaptureAssetLink>()
  let remainingDeclaredAssets = CONNECTOR_ENTITY_MAX_ASSETS
  const preserveExistingAsset = (sourceKey: string) => {
    const prefix = `${input.threadDir}/assets/${sourceKey}--`
    for (const path of existingByPath.keys()) {
      if (path.startsWith(prefix)) keptPaths.push(path)
    }
  }

  const seenKeys = new Set<string>()
  for (const media of input.media) {
    if (seenKeys.has(media.sourceKey)) continue
    seenKeys.add(media.sourceKey)
    if (remainingDeclaredAssets <= 0) {
      preserveExistingAsset(media.sourceKey)
      linksBySourceKey.set(media.sourceKey, {
        label: media.filename,
        path: stubPath(media),
        kind: slackAssetKind(media.filename, null, media.mimetype),
      })
      continue
    }
    remainingDeclaredAssets -= 1
    const downloadUrl = media.downloadUrl
    if (!downloadUrl) {
      preserveExistingAsset(media.sourceKey)
      linksBySourceKey.set(media.sourceKey, {
        label: media.filename,
        path: stubPath(media),
        kind: slackAssetKind(media.filename, null, media.mimetype),
      })
      continue
    }

    const authenticatedHosts = authenticatedHostsFor(downloadUrl)
    const downloaded = await downloadConnectorAsset({
      url: downloadUrl,
      budget,
      filename: media.filename,
      headers:
        authenticatedHosts.length > 0
          ? { Authorization: `Bearer ${input.botToken}` }
          : undefined,
      authenticatedHosts,
    })

    if (downloaded.status !== "downloaded") {
      if (
        downloaded.reason === "download_failed" ||
        downloaded.reason === "entity_limit"
      ) {
        preserveExistingAsset(media.sourceKey)
      }
      linksBySourceKey.set(media.sourceKey, {
        label: media.filename,
        path: stubPath(media),
        kind: "file",
      })
      continue
    }

    const filename = downloaded.filename
    const relativePath = `assets/${media.sourceKey}--${filename}`
    const gitPath = `${input.threadDir}/${relativePath}`
    const kind = slackAssetKind(
      filename,
      downloaded.contentType,
      media.mimetype,
    )
    linksBySourceKey.set(media.sourceKey, {
      label: filename,
      path: relativePath,
      kind,
    })

    if (connectorBlobUnchanged(gitPath, downloaded.bytes, existingByPath)) {
      keptPaths.push(gitPath)
      continue
    }
    files.push(connectorAssetCommitFile(gitPath, downloaded.bytes))
  }

  return { files, linksBySourceKey, keptPaths }
}
