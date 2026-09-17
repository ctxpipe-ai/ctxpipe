import { describe, expect, it } from "vitest"
import {
  parseGithubPrConfigYamlContent,
  renderGithubPrConfigYaml,
} from "./config-yaml.js"

describe("github/config.yaml", () => {
  it("round-trips an explicit merged-only repository list", () => {
    const raw = renderGithubPrConfigYaml({
      repositories: ["acme/worker", "acme/api"],
    })
    expect(parseGithubPrConfigYamlContent(raw)).toEqual({
      repositories: ["acme/api", "acme/worker"],
      states: ["merged"],
      includeDrafts: false,
      maxPullRequestsPerRepository: 100,
    })
  })

  it("rejects yaml that is not a github pull-request config", () => {
    expect(parseGithubPrConfigYamlContent("source: linear\n")).toBeUndefined()
  })
})
