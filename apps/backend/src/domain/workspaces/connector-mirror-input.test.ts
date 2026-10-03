import { expect, it } from "vitest"
import { connectorMirrorContentSchema } from "./connector-mirror-input.js"

const source = {
  connectionId: "con_1",
  repositoryId: "repo_1",
  configBlobSha: "a".repeat(40),
}

it("accepts optional contentSyncGeneration without requiring it on other providers", () => {
  expect(
    connectorMirrorContentSchema.safeParse({
      mirror: { ...source, provider: "github", contentSyncGeneration: 4 },
      files: [{ path: "github/config.yaml", content: "version: 1\n" }],
      deletePaths: [],
    }).success,
  ).toBe(true)
  expect(
    connectorMirrorContentSchema.safeParse({
      mirror: { ...source, provider: "github" },
      files: [{ path: "github/config.yaml", content: "version: 1\n" }],
      deletePaths: [],
    }).success,
  ).toBe(true)
  expect(
    connectorMirrorContentSchema.safeParse({
      mirror: { ...source, provider: "pagerduty" },
      files: [
        {
          path: "pagerduty/incidents/1--PINCIDENT.md",
          content: "# Incident\n",
        },
      ],
      deletePaths: [],
    }).success,
  ).toBe(true)
})

it("allows github/config.yaml on the default-branch broker path and rejects other provider config files", () => {
  expect(
    connectorMirrorContentSchema.safeParse({
      mirror: { ...source, provider: "github" },
      files: [{ path: "github/config.yaml", content: "version: 1\n" }],
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
      mirror: { ...source, provider: "pagerduty" },
      files: [
        {
          path: "pagerduty/incidents/1--PINCIDENT.md",
          content: "# Incident\n",
        },
      ],
      deletePaths: [],
    }).success,
  ).toBe(true)
})
