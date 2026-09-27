import type { Env } from "../../config/env.js"
import { getFileContent } from "../github/installation-write-client.js"
import { PAGERDUTY_CONFIG_PATH } from "./converter.js"
import {
  parsePagerdutyConfigYamlContent,
  type ParsedPagerdutyRepoConfig,
} from "./config-yaml.js"

export { PAGERDUTY_CONFIG_PATH }

export async function loadPagerdutyScopeFromRepo(input: {
  orgId: string
  env: Env
  repositoryName: string
  githubConnectionId: string
  branch: string
}): Promise<ParsedPagerdutyRepoConfig | undefined> {
  const raw = await getFileContent({
    orgId: input.orgId,
    env: input.env,
    repositoryName: input.repositoryName,
    githubConnectionId: input.githubConnectionId,
    branch: input.branch,
    path: PAGERDUTY_CONFIG_PATH,
  })
  return parsePagerdutyConfigYamlContent(raw)
}
