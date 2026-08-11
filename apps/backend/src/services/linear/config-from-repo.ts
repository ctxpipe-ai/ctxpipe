import type { Env } from "../../config/env.js"
import { getFileContent } from "../github/installation-write-client.js"
import type { ParsedLinearRepoConfig } from "./config-yaml.js"
import { parseLinearConfigYamlContent } from "./config-yaml.js"

export const LINEAR_CONFIG_PATH = "linear/config.yaml"

export async function loadLinearScopeFromRepo(input: {
  orgId: string
  env: Env
  repositoryName: string
  githubConnectionId: string
  branch: string
}): Promise<ParsedLinearRepoConfig | undefined> {
  const raw = await getFileContent({
    orgId: input.orgId,
    env: input.env,
    repositoryName: input.repositoryName,
    githubConnectionId: input.githubConnectionId,
    branch: input.branch,
    path: LINEAR_CONFIG_PATH,
  })
  return parseLinearConfigYamlContent(raw)
}
