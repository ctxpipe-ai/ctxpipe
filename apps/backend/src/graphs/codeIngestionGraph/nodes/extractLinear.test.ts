import { matchesGlob } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { isConventionalEvidenceSourceId } from "../../../domain/codeIngestion/evidenceSourceId.js"
import type { CodeIngestionState } from "../schemas.js"

const mocks = vi.hoisted(() => ({
  globFiles: vi.fn(),
  fetchFiles: vi.fn(),
  resolveSourceRepositoryId: vi.fn(),
}))

vi.mock("../../../domain/codeIngestion/codesearchClient.js", () => ({
  globFiles: mocks.globFiles,
  fetchFiles: mocks.fetchFiles,
}))
vi.mock("./repositoryResolution.js", () => ({
  resolveSourceRepositoryId: mocks.resolveSourceRepositoryId,
}))

import {
  renderLinearEntity,
  renderLinearIssue,
} from "../../../services/linear/converter.js"
import { linearRootPath } from "../../../services/linear/source-adapter.js"
import {
  extractLinear,
  parseLinearIssueMarkdown,
  parseLinearTeamMarkdown,
} from "./extractLinear.js"

const ISSUE_PATH = "linear/issues/eng-123-split-user-create--11111111.md"
const TEAM_PATH = "linear/teams/backend--t1.md"

const ISSUE = `---
source: linear
type: issue
id: 11111111-2222
identifier: ENG-123
title: Split user create
url: https://linear.app/acme/issue/ENG-123/split-user-create
state: Done
priority: High
team: Backend
teamKey: ENG
teamId: t1
project: Auth cleanup
projectId: p1
assignee: Alice Example
labels:
  - backend
createdAt: 2026-03-01T00:00:00.000Z
updatedAt: 2026-03-02T00:00:00.000Z
githubReferences:
  - kind: pull_request
    url: https://github.com/acme/api/pull/42
    title: acme/api#42
    state: merged
  - kind: commit
    url: https://github.com/acme/api/commit/abc
    title: abc
---

# ENG-123: Split user create

Move logic out of the handler.

## Comments

### 2026-03-01T10:00:00.000Z · bob

Looks good.
`

const TEAM = `---
source: linear
type: team
id: t1
title: Backend
url: https://linear.app/acme/team/ENG
key: ENG
parentId: null
---

# Backend

Owns the API.
`

const fixtures: Record<string, string> = {
  [ISSUE_PATH]: ISSUE,
  [TEAM_PATH]: TEAM,
}

function state(
  overrides: Partial<CodeIngestionState> = {},
): CodeIngestionState {
  return {
    repositoryId: "repo_ctx",
    orgId: "org_1",
    targetHash: "abc",
    githubConnectionId: "con_gh",
    roots: ["./"],
    extractedObjects: [],
    extractedClaims: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.globFiles.mockImplementation(
    async (_repo: string, _org: string, opts: { pattern: string }) => ({
      // Codesearch matches with Bun.Glob; `matchesGlob` has the same `**` rules.
      entries: Object.keys(fixtures)
        .filter((path) => matchesGlob(path, opts.pattern))
        .map((path) => ({ type: "file", path })),
    }),
  )
  mocks.fetchFiles.mockImplementation(
    async (_repo: string, _org: string, paths: string[]) =>
      Object.fromEntries(paths.map((path) => [path, fixtures[path]])),
  )
  mocks.resolveSourceRepositoryId.mockResolvedValue("repo_api")
})

describe("renderer round trip", () => {
  it("parses what renderLinearIssue and renderLinearEntity actually write", () => {
    const issueFile = renderLinearIssue({
      id: "11111111-2222",
      identifier: "ENG-123",
      title: "Split user create",
      description:
        "Move logic out of the handler.\n\nSee `src/http/createUser.ts`.",
      url: "https://linear.app/acme/issue/ENG-123/split-user-create",
      priorityLabel: "High",
      state: "Done",
      teamId: "t1",
      teamKey: "eng",
      teamName: "Backend",
      projectId: "p1",
      projectName: "Auth cleanup",
      milestoneId: "m1",
      milestone: "Beta",
      parentId: "00000000-0001",
      parent: "ENG-100",
      relations: [{ type: "blocks", identifier: "ENG-124" }],
      assignee: "Alice Example",
      labels: [{ id: "l1", name: "backend" }],
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      updatedAt: new Date("2026-03-02T00:00:00.000Z"),
      comments: [
        {
          id: "c1",
          body: "Looks good.",
          userName: "bob",
          createdAt: new Date("2026-03-01T10:00:00.000Z"),
          updatedAt: new Date("2026-03-01T10:00:00.000Z"),
        },
      ],
      attachments: [
        {
          id: "a1",
          title: "acme/api#42",
          url: "https://github.com/acme/api/pull/42",
          sourceType: "github",
          metadata: { state: "merged" },
        },
        {
          id: "a2",
          title: "abc",
          url: "https://github.com/acme/api/commit/abc123",
          sourceType: "github",
        },
        { id: "a3", title: "Spec", url: "https://www.notion.so/acme/Spec-abc" },
      ],
    })
    expect(issueFile.path).toBe("linear/issues/eng-123--11111111-2222.md")
    const issue = parseLinearIssueMarkdown(issueFile.content)
    expect(issue).toMatchObject({
      identifier: "ENG-123",
      title: "Split user create",
      teamKey: "ENG",
      team: "Backend",
      project: "Auth cleanup",
      milestone: "Beta",
      parent: "ENG-100",
      relations: [{ type: "blocks", identifier: "ENG-124" }],
      labels: ["backend"],
      githubPullRequests: [
        { url: "https://github.com/acme/api/pull/42", state: "merged" },
      ],
    })
    expect(issue?.excerpt).toContain("Move logic out of the handler.")
    expect(issue?.excerpt).not.toContain("Looks good.")

    const teamFile = renderLinearEntity({
      directory: "teams",
      type: "team",
      id: "t1",
      title: "Backend",
      url: "https://linear.app/acme/team/ENG",
      body: "Owns the API.",
      metadata: { key: "ENG", parentId: null },
    })
    expect(parseLinearTeamMarkdown(teamFile.content)).toEqual({
      id: "t1",
      key: "ENG",
      title: "Backend",
      url: "https://linear.app/acme/team/ENG",
      summary: "Owns the API.",
    })
  })
})

describe("parseLinearIssueMarkdown", () => {
  it("reads identity, hierarchy, references and a description excerpt", () => {
    const parsed = parseLinearIssueMarkdown(ISSUE)
    expect(parsed).toMatchObject({
      identifier: "ENG-123",
      title: "Split user create",
      teamKey: "ENG",
      team: "Backend",
      project: "Auth cleanup",
      labels: ["backend"],
      githubPullRequests: [
        { url: "https://github.com/acme/api/pull/42", state: "merged" },
      ],
      excerpt: "Move logic out of the handler.",
    })
    expect(parseLinearIssueMarkdown("# no frontmatter")).toBeNull()
    expect(parseLinearIssueMarkdown("---\nsource: notion\n---\n# x")).toBeNull()
  })
})

describe("extractLinear", () => {
  it("emits Issue and Team nodes, Team OWNS Issue, and Issue REFERENCES the resolved pull request", async () => {
    const { extractedObjects = [], extractedClaims = [] } = await extractLinear(
      state(),
    )

    const issue = extractedObjects.find((object) => object.kind === "Issue")
    expect(issue).toMatchObject({
      deduplicationKey: "iss:linear:ENG-123",
      name: "ENG-123: Split user create",
      summary: "Split user create",
    })
    expect(issue?.payload).toMatchObject({
      identifier: "ENG-123",
      team_key: "ENG",
      project: "Auth cleanup",
      labels: ["backend"],
      excerpt: "Move logic out of the handler.",
    })
    expect(issue?.payload).not.toHaveProperty("assignee")

    const team = extractedObjects.find((object) => object.kind === "Team")
    expect(team).toMatchObject({
      deduplicationKey: "team:linear:ENG",
      name: "Backend",
      summary: "Owns the API.",
      payload: {
        key: "ENG",
        source: "linear",
        url: "https://linear.app/acme/team/ENG",
        linear_id: "t1",
      },
    })
    expect(
      extractedObjects.filter((object) => object.kind === "Team"),
    ).toHaveLength(1)

    expect(
      extractedClaims.map((claim) => [
        claim.predicate,
        claim.subjectRef,
        claim.objectRef,
      ]),
    ).toEqual([
      ["OWNS", "team:linear:ENG", "iss:linear:ENG-123"],
      ["REFERENCES", "iss:linear:ENG-123", "prq:repo_api:42"],
    ])
    for (const claim of extractedClaims) {
      expect(
        isConventionalEvidenceSourceId(claim.sourceId, "repo_ctx", "abc"),
      ).toBe(true)
    }
    expect(mocks.resolveSourceRepositoryId).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: "acme/api",
        githubConnectionId: "con_gh",
      }),
    )
  })

  it("gives an issue without a milestone an empty milestone, so the projection clears an old one", async () => {
    const { extractedObjects = [] } = await extractLinear(state())
    expect(
      extractedObjects.find((object) => object.kind === "Issue")?.payload,
    ).toMatchObject({ milestone: "" })
  })

  it("links the parent issue and related issues and keeps the milestone on the Issue", async () => {
    const original = fixtures[ISSUE_PATH] ?? ""
    fixtures[ISSUE_PATH] = original.replace(
      "assignee: Alice Example\n",
      [
        "assignee: Alice Example",
        "milestone: Beta",
        "milestoneId: m1",
        "parent: ENG-100",
        "parentId: p100",
        "relations:",
        "  - type: blocks",
        "    identifier: ENG-124",
        "  - type: duplicate",
        "    identifier: OPS-7",
        "  - type: related",
        "    identifier: ENG-125",
        "  - type: related",
        "    identifier: ENG-124",
        "  - type: similar",
        "    identifier: ENG-126",
        "  - type: unknown-kind",
        "    identifier: ENG-127",
        "",
      ].join("\n"),
    )
    try {
      const { extractedObjects = [], extractedClaims = [] } =
        await extractLinear(state())
      expect(
        extractedObjects.find((object) => object.kind === "Issue")?.payload,
      ).toMatchObject({ milestone: "Beta" })
      expect(
        extractedClaims
          .filter((claim) => claim.objectKind === "Issue")
          .filter((claim) => claim.subjectKind === "Issue")
          .map((claim) => [claim.subjectRef, claim.predicate, claim.objectRef]),
      ).toEqual([
        ["iss:linear:ENG-123", "PART_OF", "iss:linear:ENG-100"],
        ["iss:linear:ENG-124", "DEPENDS_ON", "iss:linear:ENG-123"],
        ["iss:linear:OPS-7", "SUPERSEDES", "iss:linear:ENG-123"],
        ["iss:linear:ENG-123", "REFERENCES", "iss:linear:ENG-125"],
        ["iss:linear:ENG-123", "REFERENCES", "iss:linear:ENG-124"],
      ])
      const sourceIds = extractedClaims.map((claim) => claim.sourceId)
      expect(new Set(sourceIds).size).toBe(sourceIds.length)
      for (const claim of extractedClaims) {
        expect(
          isConventionalEvidenceSourceId(claim.sourceId, "repo_ctx", "abc"),
        ).toBe(true)
      }
    } finally {
      fixtures[ISSUE_PATH] = original
    }
  })

  it("falls back to a name-scoped pull request key when the repository is not connected", async () => {
    mocks.resolveSourceRepositoryId.mockResolvedValue(undefined)
    const { extractedClaims = [] } = await extractLinear(state())
    expect(
      extractedClaims.find((claim) => claim.predicate === "REFERENCES")
        ?.objectRef,
    ).toBe("prq:github:acme/api:42")
  })

  it("creates a minimal Team from issue frontmatter when no team file exists", async () => {
    delete fixtures[TEAM_PATH]
    try {
      const { extractedObjects = [] } = await extractLinear(state())
      const team = extractedObjects.find((object) => object.kind === "Team")
      expect(team).toMatchObject({
        deduplicationKey: "team:linear:ENG",
        name: "Backend",
      })
      expect(team?.payload).toEqual({ key: "ENG", source: "linear" })
    } finally {
      fixtures[TEAM_PATH] = TEAM
    }
  })

  it("restricts to changed paths on partial ingest and skips deletes-only diffs", async () => {
    const partial = await extractLinear(
      state({
        ingestMode: "partial",
        changedPaths: ["linear/issues/other--2.md"],
      }),
    )
    expect(partial).toEqual({})

    const deletesOnly = await extractLinear(
      state({ ingestMode: "partial", deletedPaths: [ISSUE_PATH] }),
    )
    expect(deletesOnly).toEqual({})
    expect(mocks.globFiles).toHaveBeenCalledTimes(2)
  })

  it("reads the team and project roots of the Workspace source layout, one Issue per identifier", async () => {
    const teamRoot = linearRootPath({ kind: "team", key: "ENG" })
    const projectRoot = linearRootPath({ kind: "project", id: "p1" })
    const local = ISSUE_PATH.slice("linear/".length)
    for (const path of Object.keys(fixtures)) delete fixtures[path]
    fixtures[`${teamRoot}${local}`] = ISSUE
    fixtures[`${projectRoot}${local}`] = ISSUE
    fixtures[`${teamRoot}${TEAM_PATH.slice("linear/".length)}`] = TEAM
    try {
      const { extractedObjects = [] } = await extractLinear(state())
      expect(
        extractedObjects
          .filter((object) => object.kind === "Issue")
          .map((object) => object.deduplicationKey),
      ).toEqual(["iss:linear:ENG-123"])
      expect(
        extractedObjects.find((object) => object.kind === "Team"),
      ).toMatchObject({ deduplicationKey: "team:linear:ENG", name: "Backend" })
    } finally {
      for (const path of Object.keys(fixtures)) delete fixtures[path]
      fixtures[ISSUE_PATH] = ISSUE
      fixtures[TEAM_PATH] = TEAM
    }
  })

  it("skips malformed issues and derives the team from the identifier when the mirror lacks it", async () => {
    fixtures["linear/issues/bad--3.md"] =
      "---\nsource: linear\ntype: issue\ntitle: no identifier\n---\n# x"
    fixtures["linear/issues/ops-9--4.md"] =
      "---\nsource: linear\ntype: issue\nidentifier: OPS-9\ntitle: Rotate keys\n---\n\n# OPS-9: Rotate keys\n\nBody.\n"
    try {
      const { extractedObjects = [], extractedClaims = [] } =
        await extractLinear(state())
      expect(
        extractedObjects
          .filter((object) => object.kind === "Issue")
          .map((o) => o.deduplicationKey),
      ).toEqual(["iss:linear:ENG-123", "iss:linear:OPS-9"])
      expect(
        extractedClaims.filter(
          (claim) => claim.objectRef === "iss:linear:OPS-9",
        ),
      ).toEqual([
        expect.objectContaining({
          predicate: "OWNS",
          subjectRef: "team:linear:OPS",
        }),
      ])
      expect(
        extractedObjects.find(
          (object) => object.deduplicationKey === "team:linear:OPS",
        ),
      ).toMatchObject({
        kind: "Team",
        name: "OPS",
        payload: { key: "OPS", source: "linear" },
      })
    } finally {
      delete fixtures["linear/issues/bad--3.md"]
      delete fixtures["linear/issues/ops-9--4.md"]
    }
  })
})
