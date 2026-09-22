import type { Env } from "../../../config/env.js"
import { getFileContent } from "../installation-write-client.js"
import {
  type GithubPrMirrorRepoConfig,
  parseGithubPrConfigYamlContent,
} from "./config-yaml.js"
import { GITHUB_PR_CONFIG_PATH } from "./converter.js"

export async function loadGithubPrMirrorConfigFromRepo(input: {
  orgId: string
  env: Env
  repositoryName: string
  githubConnectionId: string
  branch: string
}): Promise<GithubPrMirrorRepoConfig | undefined> {
  const raw = await getFileContent({
    orgId: input.orgId,
    env: input.env,
    repositoryName: input.repositoryName,
    githubConnectionId: input.githubConnectionId,
    branch: input.branch,
    path: GITHUB_PR_CONFIG_PATH,
  })
  return parseGithubPrConfigYamlContent(raw)
}
