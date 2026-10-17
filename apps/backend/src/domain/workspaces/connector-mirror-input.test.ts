import { expect, it } from "vitest"
import { connectorMirrorContentSchema } from "./connector-mirror-input.js"

const source = {
  connectionId: "con_1",
  repositoryId: "repo_1",
  configBlobSha: "a".repeat(40),
}

const incident = {
  path: "pagerduty/incidents/1--PINCIDENT.md",
  content: "# Incident\n",
}

it("accepts a configured connector's content and rejects its config file", () => {
  expect(
    connectorMirrorContentSchema.safeParse({
      mirror: { ...source, provider: "pagerduty" },
      files: [incident],
      deletePaths: [],
    }).success,
  ).toBe(true)
  expect(
    connectorMirrorContentSchema.safeParse({
      mirror: { ...source, provider: "pagerduty" },
      files: [{ path: "pagerduty/config.yaml", content: "version: 1\n" }],
      deletePaths: [],
    }).success,
  ).toBe(false)
  expect(
    connectorMirrorContentSchema.safeParse({
      mirror: { ...source, provider: "pagerduty", contentSyncGeneration: 4 },
      files: [incident],
      deletePaths: [],
    }).success,
  ).toBe(false)
})

it("binds a GitHub pull-request mirror to its linked repository URL only", () => {
  const pull = {
    path: "github/pulls/acme/api/7--70.md",
    content: "# Ship it\n",
  }
  const parsed = connectorMirrorContentSchema.safeParse({
    mirror: { provider: "github", gitUrl: "https://github.com/Acme/API.git" },
    files: [pull],
    deletePaths: [],
  })
  expect(parsed.success).toBe(true)
  expect(parsed.data?.mirror).toEqual({
    provider: "github",
    gitUrl: "https://github.com/acme/api",
  })
  // No binding fields, and no config file: the Workspace's link is the scope.
  expect(
    connectorMirrorContentSchema.safeParse({
      mirror: { ...source, provider: "github" },
      files: [pull],
      deletePaths: [],
    }).success,
  ).toBe(false)
  expect(
    connectorMirrorContentSchema.safeParse({
      mirror: { provider: "github", gitUrl: "https://github.com/acme/api" },
      files: [{ path: "github/config.yaml", content: "version: 1\n" }],
      deletePaths: [],
    }).success,
  ).toBe(false)
})
