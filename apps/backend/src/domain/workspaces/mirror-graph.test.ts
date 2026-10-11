import { describe, expect, it } from "vitest"
import { toConfluenceMarkdownFile } from "../../services/confluence/converter.js"
import {
  type LinearIssueForMirror,
  renderLinearEntity,
  renderLinearIssue,
} from "../../services/linear/converter.js"
import { linearRootPath } from "../../services/linear/source-adapter.js"
import {
  hydrateKnowledgeTree,
  hydrateUnitsToProjectionClaims,
} from "./hydrate.js"
import { computeWorkspaceGraphQuality } from "./workspace-graph.js"

const WORKSPACE_URL = "https://github.com/acme/context"

/** Puts a Linear walk file under its team root, as the source sync does. */
function underTeam(file: { path: string; content: string }, key: string) {
  return {
    path: `${linearRootPath({ kind: "team", key })}${file.path.slice("linear/".length)}`,
    content: file.content,
  }
}

function issue(
  overrides: Partial<LinearIssueForMirror> & {
    id: string
    identifier: string
  },
): LinearIssueForMirror {
  return {
    title: "An issue",
    url: `https://linear.app/acme/issue/${overrides.identifier}/an-issue`,
    priorityLabel: "No priority",
    teamKey: "ENG",
    labels: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
    comments: [],
    attachments: [],
    ...overrides,
  }
}

const confluencePages = [
  { id: "100", title: "Home", parentId: null },
  { id: "101", title: "Runbook", parentId: "100" },
  { id: "102", title: "Payments design", parentId: "100" },
  { id: "103", title: "Draft notes", parentId: "100" },
]

function confluencePage(pageId: string, title: string, bodyStorage: string) {
  return toConfluenceMarkdownFile({
    spaceKey: "ENG",
    pageId,
    title,
    bodyStorage,
    pages: confluencePages,
    // Page 103 is not in the scope, so it is not mirrored.
    selectedIds: new Set(["101", "102"]),
    pathRootSkipPageIds: new Set(["100"]),
  })
}

function mirrorFixture() {
  const project = underTeam(
    renderLinearEntity({
      directory: "projects",
      type: "project",
      id: "proj-uuid-1",
      title: "Payments revamp",
      url: "https://linear.app/acme/project/payments-revamp-1a2b3c4d5e6f",
      body: "Ship the new ledger.",
    }),
    "ENG",
  )
  const eng1 = underTeam(
    renderLinearIssue(
      issue({
        id: "issue-uuid-1",
        identifier: "ENG-1",
        title: "Build the ledger",
        description: [
          "Blocked by [ENG-2](https://linear.app/acme/issue/ENG-2/fix-rounding).",
          "Part of https://linear.app/acme/project/payments-revamp-1a2b3c4d5e6f/overview.",
          "Design: https://acme.atlassian.net/wiki/spaces/ENG/pages/102/Payments+design",
          "Also see [OPS-9](https://linear.app/acme/issue/OPS-9/not-mirrored) and https://example.com/spec.",
        ].join("\n"),
      }),
    ),
    "ENG",
  )
  const eng2 = underTeam(
    renderLinearIssue(
      issue({ id: "issue-uuid-2", identifier: "ENG-2", title: "Fix rounding" }),
    ),
    "ENG",
  )
  const runbook = confluencePage(
    "101",
    "Runbook",
    [
      "<p>Read the ",
      '<ac:link><ri:page ri:content-title="Payments design" /><ac:plain-text-link-body><![CDATA[design]]></ac:plain-text-link-body></ac:link>',
      ", the ",
      '<ac:link><ri:page ri:content-title="Draft notes" /><ac:plain-text-link-body><![CDATA[draft]]></ac:plain-text-link-body></ac:link>',
      ", and track it in ",
      '<a href="https://linear.app/acme/issue/ENG-1/build-the-ledger">ENG-1</a>.',
      ' Code lives in <a href="https://github.com/acme/context/blob/main/knowledge/payments.md">the notes</a>.</p>',
    ].join(""),
  )
  const design = confluencePage(
    "102",
    "Payments design",
    "<p>The ledger design.</p>",
  )
  const knowledge = {
    path: "knowledge/payments.md",
    content: "# Payments\n\nThe ledger notes.\n",
  }
  return { project, eng1, eng2, runbook, design, knowledge }
}

function hydrate() {
  const fixture = mirrorFixture()
  const { units } = hydrateKnowledgeTree({
    workspaceId: "ws_mirror",
    workspaceUrl: WORKSPACE_URL,
    files: Object.values(fixture),
  })
  const claims = hydrateUnitsToProjectionClaims(units)
  const byPath = new Map(units.map((unit) => [unit.path, unit]))
  const unit = (path: string) => {
    const found = byPath.get(path)
    if (!found) throw new Error(`no unit at ${path}`)
    return found
  }
  const edges = claims.map((claim) => ({
    from: units.find((u) => u.servingId === claim.subjectId)?.path,
    to: units.find((u) => u.servingId === claim.objectId)?.path,
  }))
  return { fixture, units, claims, unit, edges }
}

describe("connector-mirror units in the Workspace graph", () => {
  it("writes the real mirror layouts that the fixture uses", () => {
    const { project, eng1, runbook, design } = mirrorFixture()
    expect(project.path).toBe(
      "linear/teams/ENG/projects/payments-revamp--proj-uuid-1.md",
    )
    expect(eng1.path).toBe("linear/teams/ENG/issues/eng-1--issue-uuid-1.md")
    expect(runbook.path).toBe("confluence/ENG/runbook--101.md")
    expect(design.path).toBe("confluence/ENG/payments-design--102.md")
  })

  it("gives each mirror unit a kind from its mirror path", () => {
    const { fixture, unit } = hydrate()
    expect(unit(fixture.eng1.path).kind).toBe("Issue")
    expect(unit(fixture.eng2.path).kind).toBe("Issue")
    expect(unit(fixture.project.path).kind).toBe("Project")
    expect(unit(fixture.runbook.path).kind).toBe("Page")
    expect(unit(fixture.design.path).kind).toBe("Page")
    expect(unit(fixture.knowledge.path).kind).toBeNull()
  })

  it("turns links between mirrored entities into edges", () => {
    const { fixture, edges } = hydrate()
    expect(edges).toEqual(
      expect.arrayContaining([
        { from: fixture.eng1.path, to: fixture.eng2.path },
        { from: fixture.eng1.path, to: fixture.project.path },
        { from: fixture.eng1.path, to: fixture.design.path },
        { from: fixture.runbook.path, to: fixture.design.path },
        { from: fixture.runbook.path, to: fixture.eng1.path },
        { from: fixture.runbook.path, to: fixture.knowledge.path },
      ]),
    )
  })

  it("keeps a link to an entity that is not mirrored external, with no edge", () => {
    const { fixture, units, claims, unit, edges } = hydrate()
    const ids = new Set(units.map((u) => u.servingId))
    for (const claim of claims) {
      expect(ids.has(claim.subjectId)).toBe(true)
      expect(ids.has(claim.objectId)).toBe(true)
    }
    // OPS-9, example.com, and the unselected Confluence page are not units.
    expect(
      edges.filter((edge) => edge.from === fixture.eng1.path),
    ).toHaveLength(3)
    expect(
      edges.filter((edge) => edge.from === fixture.runbook.path),
    ).toHaveLength(3)
    expect(unit(fixture.runbook.path).body).toContain("the draft, and")
  })

  it("leaves no mirror unit orphaned in the fixture", () => {
    const { units, claims } = hydrate()
    const quality = computeWorkspaceGraphQuality(units, claims)
    expect(quality.kinds).toEqual({
      Issue: 2,
      Project: 1,
      Page: 2,
      KnowledgeUnit: 1,
    })
    expect(quality.orphanUnits).toBe(0)
  })
})
