import type { Env } from "../../config/env.js"
import { getFileContent } from "../github/installation-write-client.js"
import type { ParsedConfluenceRepoConfig } from "./config-yaml.js"
import { parseConfluenceConfigYamlContent } from "./config-yaml.js"

const CONFLUENCE_CONFIG_PATH = "confluence/config.yaml"

export async function loadConfluenceScopeFromRepo(input: {
  orgId: string
  env: Env
  repositoryName: string
  githubConnectionId: string
  branch: string
}): Promise<ParsedConfluenceRepoConfig | undefined> {
  const raw = await getFileContent({
    orgId: input.orgId,
    env: input.env,
    repositoryName: input.repositoryName,
    githubConnectionId: input.githubConnectionId,
    branch: input.branch,
    path: CONFLUENCE_CONFIG_PATH,
  })
  return parseConfluenceConfigYamlContent(raw)
}
