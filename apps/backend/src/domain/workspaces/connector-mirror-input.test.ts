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

it("refuses a mirror path that the sources sync refuses", () => {
  const parse = (files: string[], deletePaths: string[] = []) =>
    connectorMirrorContentSchema.safeParse({
      mirror: { ...source, provider: "pagerduty" },
      files: files.map((path) => ({ path, content: "# Incident\n" })),
      deletePaths,
    }).success
  expect(parse([incident.path])).toBe(true)
  for (const path of [
    "pagerduty/incidents/café.md",
    "pagerduty/incidents/1\n.md",
    "pagerduty/incidents/.gitattributes",
  ]) {
    expect(parse([path])).toBe(false)
    // A delete removes a file that exists, so the name rules of a write do
    // not apply.
    expect(parse([], [path])).toBe(true)
  }
  for (const path of [
    "pagerduty/incidents/../../knowledge/a.md",
    "pagerduty/incidents//1.md",
    "pagerduty/incidents/..\\..\\a.md",
    "pagerduty/.git/config",
    "/pagerduty/incidents/1.md",
    "linear/teams/ENG/README.md",
    "pagerduty/config.yaml",
  ]) {
    expect(parse([path])).toBe(false)
    expect(parse([], [path])).toBe(false)
  }
  // A GitHub repository can have the name ".github": its pull requests mirror.
  expect(
    connectorMirrorContentSchema.safeParse({
      mirror: { provider: "github", gitUrl: "https://github.com/acme/.github" },
      files: [
        { path: "github/pulls/acme/.github/7--70.md", content: "# PR\n" },
      ],
      deletePaths: [],
    }).success,
  ).toBe(true)
})
