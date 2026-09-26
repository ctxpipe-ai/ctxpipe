import { beforeEach, describe, expect, it, vi } from "vitest"
import { isConventionalEvidenceSourceId } from "../../../domain/codeIngestion/evidenceSourceId.js"
import type { CodeIngestionState, ExtractedObject } from "../schemas.js"

const mocks = vi.hoisted(() => ({ globFiles: vi.fn(), fetchFiles: vi.fn() }))

vi.mock("../../../domain/codeIngestion/codesearchClient.js", () => ({
  globFiles: mocks.globFiles,
  fetchFiles: mocks.fetchFiles,
}))

import { extractDecisions, parseDecisionMarkdown } from "./extractDecisions.js"

const MADR = `---
status: accepted
date: 2026-01-10
---

# Domain logic lives in services

## Context

HTTP handlers grew fat. See \`src/http/createUser.ts\` and \`src/domain/\`.

## Decision

Put domain logic in services. Supersedes ADR-3.
`

const BOLD = `# ADR-031: GitHub pull-request scoped mirror

**Status:** Accepted | **Date:** 2026-09-16 | **Tags:** connectors, github

## Context

Review conversation is GitHub API metadata, not git objects. This is superseded by ADR-7.

## Decision

Mirror merged pull requests.
`

const STATUS_LINE = `# Old handler layering

Status: Superseded
Date: 2025-06-01

We used to keep logic in handlers.
`

const fixtures: Record<string, string> = {
  "docs/adr/0007-domain-logic-in-services.md": MADR,
  ".ai/memory/decisions/ADR-031-github-pr-scoped-mirror.md": BOLD,
  "docs/adr/0003-old-handler-layering.md": STATUS_LINE,
  "apps/backend/docs/adr/0009-backend-only.md":
    "# Backend only\n\n## Status\n\nProposed\n\nBackend detail.\n",
  "docs/adr/template.md": "# Title\n\nStatus: Proposed\n",
  "docs/adr/README.md": "# ADR index\n",
  "node_modules/pkg/adr/0001-vendored.md": "# Vendored\n\nStatus: Accepted\n",
  "linear/decisions/x.md": "# Not ours\n\nStatus: Accepted\n",
}

function service(root: string): ExtractedObject {
  return {
    kind: "Service",
    deduplicationKey: `svc:repo_api:${root}`,
    name: root,
  }
}

function state(
  overrides: Partial<CodeIngestionState> = {},
): CodeIngestionState {
  return {
    repositoryId: "repo_api",
    orgId: "org_1",
    targetHash: "abc",
    roots: ["./"],
    extractedObjects: [service("./"), service("apps/backend")],
    extractedClaims: [],
    objectIds: [],
    touchedObjectIds: [],
    claimsForProjection: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.globFiles.mockResolvedValue({
    entries: Object.keys(fixtures).map((path) => ({ type: "file", path })),
  })
  mocks.fetchFiles.mockImplementation(
    async (_repo: string, _org: string, paths: string[]) =>
      Object.fromEntries(paths.map((path) => [path, fixtures[path]])),
  )
})

describe("parseDecisionMarkdown", () => {
  it("reads MADR frontmatter, bold headers and Status lines", () => {
    expect(
      parseDecisionMarkdown(MADR, "docs/adr/0007-domain-logic-in-services.md"),
    ).toMatchObject({
      title: "Domain logic lives in services",
      adrId: "ADR-7",
      status: "accepted",
      date: "2026-01-10",
      summary: expect.stringContaining("HTTP handlers grew fat"),
      supersedes: ["ADR-3"],
      supersededBy: [],
    })
    expect(parseDecisionMarkdown(BOLD, "x/ADR-031.md")).toMatchObject({
      title: "GitHub pull-request scoped mirror",
      adrId: "ADR-31",
      status: "accepted",
      date: "2026-09-16",
      supersededBy: ["ADR-7"],
    })
    expect(
      parseDecisionMarkdown(STATUS_LINE, "docs/adr/0003-old.md"),
    ).toMatchObject({
      adrId: "ADR-3",
      status: "superseded",
      date: "2025-06-01",
    })
    expect(parseDecisionMarkdown("no heading here", "x.md")).toBeNull()
  })

  it("reads supersession written as links, in the status header or front matter", () => {
    const parse = (content: string) => parseDecisionMarkdown(content, "x.md")

    expect(
      parse(`# ADR-021: Local agent memory

**Status:** Superseded by [ADR-024](ADR-024-markdown-only-local-memory.md) | **Date:** 2026-05-25 | **Tags:** memory
`),
    ).toMatchObject({ status: "superseded", supersededBy: ["ADR-24"] })
    expect(
      parse(`# ADR-004: Local development with Docker Compose

**Status:** Superseded | **Superseded by:** [ADR-015](ADR-015-compose-profiles.md) | **Date:** 2026-02-13
`),
    ).toMatchObject({ status: "superseded", supersededBy: ["ADR-15"] })
    expect(
      parse(`# ADR-004: Local development with Docker Compose

**Status:** Superseded | **Superseded by:** [ADR-015](ADR-015-compose-profiles.md)
`),
    ).toMatchObject({ status: "superseded", supersededBy: ["ADR-15"] })
    expect(
      parse(`# ADR-024: Markdown-only local memory

**Status:** Accepted | **Date:** 2026-08-11 | **Tags:** memory

**Supersedes:** [ADR-021](ADR-021-local-agent-memory.md)
`),
    ).toMatchObject({ status: "accepted", supersedes: ["ADR-21"] })
    expect(
      parse(`---
status: "superseded by [ADR-0005](0005-example.md)"
---

# Use plain JUnit5 for advanced test assertions
`),
    ).toMatchObject({ status: "superseded", supersededBy: ["ADR-5"] })
    expect(
      parse(`# ADR-014: Parallel worktree local development

**Status:** Accepted | **Date:** 2026-03-20

## Related

- [ADR-004](ADR-004.md) (Compose layout superseded by [ADR-015](ADR-015.md))
`),
    ).toMatchObject({ status: "accepted", supersedes: [], supersededBy: [] })
  })
})

describe("extractDecisions", () => {
  it("emits Decisions with location, supersession and mention claims and skips excluded paths", async () => {
    const { extractedObjects = [], extractedClaims = [] } =
      await extractDecisions(state())

    expect(
      extractedObjects.map((object) => object.deduplicationKey).sort(),
    ).toEqual([
      "dec:repo_api:.ai/memory/decisions/ADR-031-github-pr-scoped-mirror.md",
      "dec:repo_api:apps/backend/docs/adr/0009-backend-only.md",
      "dec:repo_api:docs/adr/0003-old-handler-layering.md",
      "dec:repo_api:docs/adr/0007-domain-logic-in-services.md",
    ])
    const adr7 = extractedObjects.find((o) =>
      o.deduplicationKey.endsWith("0007-domain-logic-in-services.md"),
    )
    expect(adr7?.payload).toMatchObject({
      path: "docs/adr/0007-domain-logic-in-services.md",
      status: "accepted",
      date: "2026-01-10",
      adr_id: "ADR-7",
    })

    const triples = extractedClaims.map((c) => [
      c.predicate,
      c.subjectRef,
      c.objectRef,
    ])
    // location: repo-level ADRs influence the root Service, package ADRs their package
    expect(triples).toContainEqual([
      "INFLUENCES",
      "dec:repo_api:docs/adr/0007-domain-logic-in-services.md",
      "svc:repo_api:./",
    ])
    expect(triples).toContainEqual([
      "INFLUENCES",
      "dec:repo_api:apps/backend/docs/adr/0009-backend-only.md",
      "svc:repo_api:apps/backend",
    ])
    // supersession from both phrasings
    expect(triples).toContainEqual([
      "SUPERSEDES",
      "dec:repo_api:docs/adr/0007-domain-logic-in-services.md",
      "dec:repo_api:docs/adr/0003-old-handler-layering.md",
    ])
    expect(triples).toContainEqual([
      "SUPERSEDES",
      "dec:repo_api:docs/adr/0007-domain-logic-in-services.md",
      "dec:repo_api:.ai/memory/decisions/ADR-031-github-pr-scoped-mirror.md",
    ])
    // mentions: only paths with an extension are located
    expect(triples).toContainEqual([
      "MENTIONS",
      "dec:repo_api:docs/adr/0007-domain-logic-in-services.md",
      "fil:repo_api:src/http/createUser.ts",
    ])
    expect(
      triples.some(([, , object]) => object === "fil:repo_api:src/domain/"),
    ).toBe(false)

    for (const claim of extractedClaims) {
      expect(
        isConventionalEvidenceSourceId(claim.sourceId, "repo_api", "abc"),
      ).toBe(true)
    }
  })

  it("scopes a decision to its package, else to the services it references, else to every service in the repository", async () => {
    const adrs: Record<string, string> = {
      ".ai/memory/decisions/ADR-010-graph-db.md":
        "# ADR-010: Graph DB\n\n**Status:** Accepted\n\nThe backend (`apps/backend/src/platform/graph/client.ts`) owns graph access. See [UI notes](../../../apps/ui/README.md) and [FalkorDB](https://www.falkordb.com/).\n",
      ".ai/memory/decisions/ADR-013-terraform.md":
        "# ADR-013: Terraform\n\n**Status:** Accepted\n\nAll infrastructure is Terraform. See [HashiCorp](https://www.terraform.io/).\n",
      "apps/backend/docs/adr/0002-bun.md":
        "# Bun runtime\n\nStatus: Accepted\n\nThe UI build (`apps/ui/vite.config.ts`) stays on Node.\n",
    }
    mocks.globFiles.mockResolvedValue({
      entries: Object.keys(adrs).map((path) => ({ type: "file", path })),
    })
    mocks.fetchFiles.mockImplementation(
      async (_repo: string, _org: string, paths: string[]) =>
        Object.fromEntries(paths.map((path) => [path, adrs[path]])),
    )

    const { extractedClaims = [] } = await extractDecisions(
      state({
        extractedObjects: [service("apps/backend"), service("apps/ui")],
      }),
    )

    const influences = extractedClaims
      .filter((c) => c.predicate === "INFLUENCES")
      .map((c) => [c.subjectRef.split(":").pop(), c.objectRef, c.confidence])
      .sort()
    expect(influences).toEqual([
      [
        ".ai/memory/decisions/ADR-010-graph-db.md",
        "svc:repo_api:apps/backend",
        0.8,
      ],
      [".ai/memory/decisions/ADR-010-graph-db.md", "svc:repo_api:apps/ui", 0.8],
      [
        ".ai/memory/decisions/ADR-013-terraform.md",
        "svc:repo_api:apps/backend",
        0.6,
      ],
      [
        ".ai/memory/decisions/ADR-013-terraform.md",
        "svc:repo_api:apps/ui",
        0.6,
      ],
      ["apps/backend/docs/adr/0002-bun.md", "svc:repo_api:apps/backend", 0.9],
    ])
  })

  it("restricts to changed paths on partial ingest and skips connector-only diffs", async () => {
    const { extractedObjects = [] } = await extractDecisions(
      state({
        ingestMode: "partial",
        changedPaths: ["docs/adr/0003-old-handler-layering.md"],
      }),
    )
    expect(extractedObjects.map((o) => o.deduplicationKey)).toEqual([
      "dec:repo_api:docs/adr/0003-old-handler-layering.md",
    ])
    expect(
      await extractDecisions(
        state({ ingestMode: "partial", changedPaths: ["linear/issues/x.md"] }),
      ),
    ).toEqual({})
  })
})
