import type { Env } from "../../config/env.js"
import { getFileContent } from "../github/installation-write-client.js"
import {
  type ParsedSlackRepoConfig,
  parseSlackConfigYamlContent,
  SLACK_CONFIG_PATH,
} from "./config-yaml.js"

export { SLACK_CONFIG_PATH }

export async function loadSlackScopeFromRepo(input: {
  orgId: string
  env: Env
  repositoryName: string
  githubConnectionId: string
  branch: string
}): Promise<ParsedSlackRepoConfig | undefined> {
  const raw = await getFileContent({
    orgId: input.orgId,
    env: input.env,
    repositoryName: input.repositoryName,
    githubConnectionId: input.githubConnectionId,
    branch: input.branch,
    path: SLACK_CONFIG_PATH,
  })
  return parseSlackConfigYamlContent(raw)
}
