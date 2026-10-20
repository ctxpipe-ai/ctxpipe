import { describe, expect, it } from "vitest"
import { toConfluenceMarkdownFile } from "../../services/confluence/converter.js"
import {
  type LinearIssueForMirror,
  renderLinearEntity,
  renderLinearIssue,
} from "../../services/linear/converter.js"
import { linearRootPath } from "../../services/linear/source-adapter.js"
import { pagerdutyIncidentMirrorFiles } from "../../services/pagerduty/converter.js"
import {
  toSlackChannelIndexFile,
  toSlackThreadMarkdownFile,
} from "../../services/slack/converter.js"
import {
  zendeskArticleFile,
  zendeskTicketFile,
} from "../../services/zendesk/converter.js"
import {
  hydrateKnowledgeTree,
  hydrateUnitsToProjectionClaims,
  resolveHydrateLink,
} from "./hydrate.js"
import { claimsUpgradeRemainder } from "./hydrate-write-jobs.js"
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

function hydrate(
  extra: ReadonlyArray<{ path: string; content: string }> = [],
  confluenceSiteHosts: ReadonlySet<string> = new Set(["acme.atlassian.net"]),
) {
  const fixture = mirrorFixture()
  const { units } = hydrateKnowledgeTree({
    workspaceId: "ws_mirror",
    workspaceUrl: WORKSPACE_URL,
    files: [...Object.values(fixture), ...extra],
    confluenceSiteHosts,
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

  it("gives Notion page and database rows page kinds", () => {
    const page = {
      path: "notion/pages/planning--11111111-2222-3333-4444-555555555555/index.md",
      content:
        "---\nnotion_id: 11111111-2222-3333-4444-555555555555\n---\n# Planning\n",
    }
    const row = {
      path: "notion/databases/tasks--db-1/rows/prepare--22222222-3333-4444-5555-666666666666/index.md",
      content:
        "---\nnotion_id: 22222222-3333-4444-5555-666666666666\n---\n# Prepare\n",
    }
    const database = {
      path: "notion/databases/tasks--db-1/index.md",
      content: "---\nnotion_id: db-1\n---\n# Tasks\n",
    }
    const { unit } = hydrate([page, row, database])
    expect(unit(page.path).kind).toBe("Page")
    expect(unit(row.path).kind).toBe("Page")
    expect(unit(database.path).kind).toBe("Database")
  })

  it("links Notion page URLs by their page id", () => {
    const source = knowledge(
      "knowledge/notion-links.md",
      "https://www.notion.so/Planning-11111111222233334444555555555555",
    )
    const target = {
      path: "notion/pages/planning--11111111-2222-3333-4444-555555555555/index.md",
      content:
        "---\nnotion_id: 11111111-2222-3333-4444-555555555555\n---\n# Planning\n",
    }
    const { edges } = hydrate([source, target])
    expect(edges).toContainEqual({ from: source.path, to: target.path })
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

function knowledge(path: string, body: string) {
  return { path, content: `# ${path}\n\n${body}\n` }
}

describe("reference resolution guards", () => {
  it("does not throw on malformed URLs, and they make no edge", () => {
    const odd = knowledge(
      "knowledge/odd.md",
      [
        "https://github.com/acme/context/blob/main/50%.md",
        "https://github.com/acme/context/blob/main/%E0%A4%A.md",
        "https://linear.app/acme/issue/%ZZ/x",
        "https://acme.atlassian.net/wiki/spaces/ENG/pages/10%2/x",
        "https://[broken/wiki/spaces/ENG/pages/102",
      ].join("\n"),
    )
    const { edges } = hydrate([odd])
    expect(edges.filter((edge) => edge.from === odd.path)).toEqual([])
  })

  it("links a blob URL only to the file at the path after the ref", () => {
    const links = knowledge(
      "knowledge/links.md",
      [
        "https://github.com/acme/context/blob/main/packages/foo/README.md",
        "https://github.com/acme/context/blob/main/knowledge/payments.md",
      ].join("\n"),
    )
    const { edges } = hydrate([
      links,
      { path: "README.md", content: "# Root\n" },
    ])
    expect(edges.filter((edge) => edge.from === links.path)).toEqual([
      { from: links.path, to: "knowledge/payments.md" },
    ])
  })

  it("joins a Confluence URL only on a site of the org's Confluence connection", () => {
    const own = knowledge(
      "knowledge/own-site.md",
      "https://acme.atlassian.net/wiki/spaces/ENG/pages/102",
    )
    const other = knowledge(
      "knowledge/other-site.md",
      "https://other.atlassian.net/wiki/spaces/ENG/pages/102/Payments+design",
    )
    const { edges, fixture } = hydrate([own, other])
    expect(edges).toContainEqual({ from: own.path, to: fixture.design.path })
    expect(edges.filter((edge) => edge.from === other.path)).toEqual([])

    const noSite = hydrate([own], new Set())
    expect(noSite.edges.filter((edge) => edge.from === own.path)).toEqual([])

    // A page id is unique only in its site, and the mirror path names no site.
    const twoSites = hydrate(
      [own],
      new Set(["acme.atlassian.net", "acme-eu.atlassian.net"]),
    )
    expect(twoSites.edges.filter((edge) => edge.from === own.path)).toEqual([])
  })

  it("joins a Linear URL only in the Linear workspace that the mirror names", () => {
    const own = knowledge(
      "knowledge/own-linear.md",
      "[ticket](https://linear.app/acme/issue/ENG-2/fix-rounding)",
    )
    const other = knowledge(
      "knowledge/other-linear.md",
      "[ticket](https://linear.app/other/issue/ENG-2/fix-rounding)",
    )
    const labelled = knowledge(
      "knowledge/other-linear-labelled.md",
      "[ENG-2](https://linear.app/other/issue/ENG-2)",
    )
    const { edges, fixture } = hydrate([own, other, labelled])
    expect(edges).toContainEqual({ from: own.path, to: fixture.eng2.path })
    expect(edges.filter((edge) => edge.from === other.path)).toEqual([])
    expect(edges.filter((edge) => edge.from === labelled.path)).toEqual([])
  })

  it("keeps the meaning of a `/` link that a person wrote", () => {
    const authored = knowledge(
      "knowledge/a/b.md",
      "[root](/knowledge/payments.md)",
    )
    expect(resolveHydrateLink("knowledge/a", "/knowledge/payments.md")).toBe(
      "knowledge/a/knowledge/payments.md",
    )
    const { edges, unit } = hydrate([authored])
    expect(edges.filter((edge) => edge.from === authored.path)).toEqual([])
    expect(claimsUpgradeRemainder([unit(authored.path)])).toBe(1)
  })

  it("asks for no claim in the file for a resolved URL", () => {
    const viaUrl = knowledge(
      "knowledge/via-url.md",
      "https://linear.app/acme/issue/ENG-2/fix-rounding",
    )
    const { edges, fixture, unit } = hydrate([viaUrl])
    expect(edges).toContainEqual({ from: viaUrl.path, to: fixture.eng2.path })
    expect(claimsUpgradeRemainder([unit(viaUrl.path)])).toBe(0)
  })
})

describe("Slack, PagerDuty, and Linear project-root mirror units", () => {
  const permalink = "https://acme.slack.com/archives/C123/p1700000000000100"
  const thread = toSlackThreadMarkdownFile({
    channelId: "C123",
    channelName: "payments",
    isPrivate: false,
    threadTs: "1700000000.000100",
    permalink,
    messages: [
      { ts: "1700000000.000100", userId: "U1", text: "Deploy broke." },
    ],
  })
  const channel = toSlackChannelIndexFile({
    channelId: "C123",
    channelName: "payments",
    isPrivate: false,
  })
  const [incident] = pagerdutyIncidentMirrorFiles({
    id: "PABC123",
    number: 7,
    title: "Ledger down",
    htmlUrl: "https://acme.pagerduty.com/incidents/PABC123",
    status: "resolved",
    serviceId: "PSVC1",
    alerts: [],
    notes: [],
  })
  const projectRoot = linearRootPath({ kind: "project", id: "proj-uuid-9" })
  const inProject = (file: { path: string; content: string }) => ({
    path: `${projectRoot}${file.path.slice("linear/".length)}`,
    content: file.content,
  })
  const projectIssue = inProject(
    renderLinearIssue(
      issue({
        id: "issue-uuid-9",
        identifier: "ENG-9",
        title: "Fix the deploy",
        description: `Thread: ${permalink}`,
      }),
    ),
  )
  const projectPage = inProject(
    renderLinearEntity({
      directory: "projects",
      type: "project",
      id: "proj-uuid-9",
      title: "Deploys",
      url: "https://linear.app/acme/project/deploys-9a8b7c6d5e4f",
    }),
  )

  it("writes the real layouts", () => {
    expect(thread.path).toBe(
      "slack/channels/payments--C123/threads/2023/11/1700000000.000100/thread.md",
    )
    expect(channel.path).toBe("slack/channels/payments--C123/index.md")
    expect(incident?.path).toBe("pagerduty/incidents/7--PABC123.md")
    expect(projectIssue.path).toBe(
      "linear/projects/proj-uuid-9/issues/eng-9--issue-uuid-9.md",
    )
    expect(projectPage.path).toBe(
      "linear/projects/proj-uuid-9/projects/deploys--proj-uuid-9.md",
    )
  })

  it("gives them kinds and joins a Slack permalink to the thread file", () => {
    if (!incident) throw new Error("no incident file")
    const { unit, edges } = hydrate([
      thread,
      channel,
      incident,
      projectIssue,
      projectPage,
    ])
    expect(unit(thread.path).kind).toBe("Thread")
    expect(unit(channel.path).kind).toBe("Channel")
    expect(unit(incident.path).kind).toBe("Incident")
    expect(unit(projectIssue.path).kind).toBe("Issue")
    expect(unit(projectPage.path).kind).toBe("Project")
    expect(edges).toContainEqual({ from: projectIssue.path, to: thread.path })
  })
})

describe("Zendesk mirror units", () => {
  const article = zendeskArticleFile({
    subdomain: "acme",
    categoryId: "36",
    article: {
      id: "1",
      title: "Reset a password",
      url: "https://acme.zendesk.com/hc/en-us/articles/1",
      bodyHtml: "<p>Steps</p>",
      sectionId: null,
      sectionName: null,
      locale: null,
      labels: [],
      authorName: null,
      createdAt: null,
      updatedAt: null,
    },
  })
  const ticket = zendeskTicketFile({
    viewId: "90",
    ticket: {
      id: "11",
      subject: "Export fails",
      url: "https://acme.zendesk.com/agent/tickets/11",
      status: "open",
      priority: null,
      type: null,
      tags: [],
      requesterName: null,
      assigneeName: null,
      createdAt: null,
      updatedAt: null,
      comments: [],
    },
  })

  it("gives articles and tickets their kinds", () => {
    const { unit } = hydrate([article, ticket])
    expect(unit(article.path).kind).toBe("Article")
    expect(unit(ticket.path).kind).toBe("Ticket")
  })
})
