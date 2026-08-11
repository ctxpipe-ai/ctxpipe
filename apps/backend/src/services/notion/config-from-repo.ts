import type { Env } from "../../config/env.js"
import { getFileContent } from "../github/installation-write-client.js"
import type { ParsedNotionRepoConfig } from "./config-yaml.js"
import { parseNotionConfigYamlContent } from "./config-yaml.js"

export const NOTION_CONFIG_PATH = "notion/config.yaml"

export async function loadNotionScopeFromRepo(input: {
  orgId: string
  env: Env
  repositoryName: string
  githubConnectionId: string
  branch: string
}): Promise<ParsedNotionRepoConfig | undefined> {
  const raw = await getFileContent({
    orgId: input.orgId,
    env: input.env,
    repositoryName: input.repositoryName,
    githubConnectionId: input.githubConnectionId,
    branch: input.branch,
    path: NOTION_CONFIG_PATH,
  })
  return parseNotionConfigYamlContent(raw)
}
