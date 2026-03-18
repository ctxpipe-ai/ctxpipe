import type { GitHubClient } from "./github/client.js"

export interface SpaceScope {
  key: string
  name?: string | null
  selectedPageIds?: string[] | null
}

export interface ConnectorYamlConfig {
  type: string
  baseUrl?: string
  spaces: SpaceScope[]
}

export function generateConnectorYaml(config: ConnectorYamlConfig): string {
  const lines: string[] = [
    "# ctxpipe connector configuration",
    "# Changes to this file trigger a pull request for review.",
    `version: 1`,
    `type: ${config.type}`,
  ]

  if (config.baseUrl) {
    lines.push(`baseUrl: ${config.baseUrl}`)
  }

  lines.push("spaces:")

  for (const space of config.spaces) {
    lines.push(`  - key: ${space.key}`)
    if (space.name) {
      lines.push(`    name: ${yamlQuote(space.name)}`)
    }
    if (space.selectedPageIds && space.selectedPageIds.length > 0) {
      lines.push("    pages:")
      for (const pageId of space.selectedPageIds) {
        lines.push(`      - "${pageId}"`)
      }
    }
  }

  return lines.join("\n") + "\n"
}

function yamlQuote(value: string): string {
  if (/[:#\[\]{}&*!,|>'"?]/.test(value) || value.includes("\n")) {
    return `"${value.replace(/"/g, '\\"')}"`
  }
  return value
}

export async function readCurrentYaml(
  github: GitHubClient,
  path: string,
): Promise<string | null> {
  try {
    return await github.getFileContent(path)
  } catch {
    return null
  }
}

export async function syncConfigYaml(options: {
  github: GitHubClient
  connectorType: string
  config: ConnectorYamlConfig
  branch: string
}): Promise<{ prNumber: number; prUrl: string } | null> {
  const { github, connectorType, config, branch } = options
  const configPath = `${connectorType}/config.yaml`
  const newYaml = generateConnectorYaml(config)

  const existingYaml = await readCurrentYaml(github, configPath)

  if (existingYaml !== null && existingYaml.trim() === newYaml.trim()) {
    return null
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const branchName = `${connectorType}-config/${timestamp}`

  const pr = await github.createPullRequestWithFiles({
    title: `Update ${connectorType} connector scope`,
    body: generateConfigPRBody(connectorType, config, existingYaml === null),
    branchName,
    base: branch,
    files: [{ path: configPath, content: newYaml }],
  })

  return pr
}

function generateConfigPRBody(
  connectorType: string,
  config: ConnectorYamlConfig,
  isInitial: boolean,
): string {
  const spaceList = config.spaces
    .map((s) => {
      const pagesNote =
        s.selectedPageIds && s.selectedPageIds.length > 0
          ? ` (${s.selectedPageIds.length} page(s) selected)`
          : " (all pages)"
      return `- **${s.key}**${s.name ? ` — ${s.name}` : ""}${pagesNote}`
    })
    .join("\n")

  return [
    isInitial
      ? `## Initial ${connectorType} connector configuration`
      : `## Updated ${connectorType} connector scope`,
    "",
    isInitial
      ? "This PR records the initial connector scope in version control."
      : "This PR records a scope change made via the ctxpipe UI. The change is already active — this PR exists for review and audit purposes.",
    "",
    "### Spaces",
    spaceList,
  ].join("\n")
}
