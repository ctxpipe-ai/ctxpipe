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
      maxPullRequestsPerRepository: 200,
      issues: { maxIssuesPerRepository: 200 },
    })
  })

  it("reads a yaml written before issue capture as having no issue section", () => {
    const config = parseGithubPrConfigYamlContent(
      "version: 1\nsource: github\npullRequests:\n  repositories: [acme/api]\n",
    )
    expect(config?.repositories).toEqual(["acme/api"])
    expect(config?.issues).toBeUndefined()
  })

  it("keeps the operator's policy when only the repository list changes", () => {
    const current = parseGithubPrConfigYamlContent(
      [
        "pullRequests:",
        "  repositories: [acme/api]",
        "  states: [open, merged]",
        "  includeDrafts: true",
        "  updatedSince: 2026-01-01",
        "  maxPullRequestsPerRepository: 50",
      ].join("\n"),
    )
    expect(
      parseGithubPrConfigYamlContent(
        renderGithubPrConfigYaml({ repositories: ["acme/web"], current }),
      ),
    ).toEqual({
      repositories: ["acme/web"],
      states: ["open", "merged"],
      includeDrafts: true,
      updatedSince: "2026-01-01",
      maxPullRequestsPerRepository: 50,
      issues: { maxIssuesPerRepository: 200 },
    })
  })

  it("defaults an omitted pull-request cap to 200", () => {
    expect(
      parseGithubPrConfigYamlContent(
        [
          "version: 1",
          "source: github",
          "pullRequests:",
          "  repositories: [acme/api]",
          "  states: [merged]",
        ].join("\n"),
      ),
    ).toMatchObject({ maxPullRequestsPerRepository: 200 })
  })

  it("rejects yaml that is not a github pull-request config", () => {
    expect(parseGithubPrConfigYamlContent("source: linear\n")).toBeUndefined()
  })
})
