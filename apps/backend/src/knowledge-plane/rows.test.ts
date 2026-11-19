import { describe, expect, it } from "vitest"
import { stringify } from "yaml"

import {
  applyEffectiveValidFromToUnits,
  hydrateKnowledgeTree,
  servingIdForKnowledgePath,
} from "../domain/workspaces/hydrate.js"
import { knowledgeRows } from "./rows.js"

const WS = "ws_1"
const OBSERVED = new Date("2026-11-19T10:00:00.000Z")
const key = (path: string) => servingIdForKnowledgePath(WS, path)
const HASH = "a".repeat(64)

function rowsOf(
  files: Array<{ path: string; content: string }>,
  path: string,
  imageHashes: ReadonlyMap<string, string | null> = new Map(),
) {
  const { units } = hydrateKnowledgeTree({ workspaceId: WS, files })
  const unit = units.find((entry) => entry.path === path)
  if (!unit) throw new Error(`no unit for ${path}`)
  return knowledgeRows({
    workspaceId: WS,
    unit,
    imageHash: (image) => imageHashes.get(image) ?? null,
    observedAt: OBSERVED,
  })
}

const edges = (
  relations: ReadonlyArray<{
    predicate: string
    dstDoc: string
    srcChunk: number
  }>,
) =>
  relations.map(({ predicate, dstDoc, srcChunk }) => ({
    predicate,
    dstDoc,
    srcChunk,
  }))

describe("knowledgeRows", () => {
  it("maps a file with a claim and a body link to one document, its chunks and its relations", () => {
    // The fixture of the hydrate test. The ledger file is not in the tree:
    // the relations still point at its key, and the read resolves it.
    const rows = rowsOf(
      [
        {
          path: "knowledge/payments/api.md",
          content:
            "---\nclaims:\n  - to: ../billing/ledger.md\n    predicate: DEPENDS_ON\n---\nSee [ledger](../billing/ledger.md).\n",
        },
      ],
      "knowledge/payments/api.md",
    )
    const ledger = key("knowledge/billing/ledger.md")
    expect(rows).toEqual([
      {
        document: {
          docKey: key("knowledge/payments/api.md"),
          kind: "KnowledgeUnit",
          status: "active",
          deletedAt: null,
          error: "",
          title: "api",
          path: "knowledge/payments/api.md",
          sourceType: "docs",
          source: "",
          summary: "See [ledger](../billing/ledger.md).",
          s3Key: "",
          mime: "",
          validFrom: null,
          validTo: null,
          observedAt: OBSERVED,
        },
        chunks: [
          {
            ordinal: 0,
            text: "See [ledger](../billing/ledger.md).",
            startLine: 6,
            endLine: 6,
          },
        ],
        relations: [
          {
            srcChunk: 0,
            predicate: "DEPENDS_ON",
            dstDoc: ledger,
            confidence: 0.5,
            validFrom: null,
            validTo: null,
            source: "",
            observedAt: OBSERVED,
          },
          {
            srcChunk: 0,
            predicate: "LINKS_TO",
            dstDoc: ledger,
            confidence: 1,
            validFrom: null,
            validTo: null,
            source: "git",
            observedAt: OBSERVED,
          },
        ],
      },
    ])
  })

  it("maps the kind and the FROM_SOURCE relations of a file that lists sources", () => {
    const [rows] = rowsOf(
      [
        {
          path: "sources/github/acme/shop.md",
          content: "---\nprovider: github\n---\nThe shop.\n",
        },
        {
          path: "knowledge/services/api.md",
          content: `---\n${stringify({
            kind: "Service",
            sources: ["sources/github/acme/shop.md"],
          })}---\n# API\n`,
        },
      ],
      "knowledge/services/api.md",
    )
    expect(rows?.document).toMatchObject({ kind: "Service", title: "API" })
    expect(rows?.chunks).toEqual([
      { ordinal: 0, text: "API\n\n# API", startLine: 6, endLine: 6 },
    ])
    expect(edges(rows?.relations ?? [])).toEqual([
      {
        predicate: "FROM_SOURCE",
        dstDoc: key("sources/github/acme/shop.md"),
        srcChunk: 0,
      },
    ])
  })

  it("records the validity window of a claim and the chunk that states its link", () => {
    const path = "knowledge/payments/limits.md"
    const content = `---\n${stringify({
      claims: [
        {
          to: "../billing/ledger.md",
          predicate: "SUPERSEDES",
          confidence: 0.9,
          valid_from: "2026-01-01",
          valid_to: "2026-06-30T12:00:00",
          source: "https://example.com/rfc/7",
        },
        { to: "./rates.md", predicate: "USES", valid_from: "abc1234" },
      ],
    })}---\n# Limits\n\nDaily caps.\n\n## History\n\nThe [old ledger](../billing/ledger.md) set them.\n`
    const { units } = hydrateKnowledgeTree({
      workspaceId: WS,
      files: [{ path, content }],
    })
    // A Git SHA as `valid_from` becomes the time of the introducing commit.
    const [unit] = applyEffectiveValidFromToUnits(
      units,
      new Map([[path, "2026-02-03T04:05:06.000Z"]]),
    )
    if (!unit) throw new Error("no unit")
    const [rows] = knowledgeRows({
      workspaceId: WS,
      unit,
      imageHash: () => null,
      observedAt: OBSERVED,
    })
    expect(rows?.chunks).toEqual([
      {
        ordinal: 0,
        text: "Limits\n\n# Limits\n\nDaily caps.",
        startLine: 13,
        endLine: 15,
      },
      {
        ordinal: 1,
        text: "Limits > History\n\n## History\n\nThe [old ledger](../billing/ledger.md) set them.",
        startLine: 17,
        endLine: 19,
      },
    ])
    expect(rows?.relations).toEqual([
      {
        srcChunk: 1,
        predicate: "SUPERSEDES",
        dstDoc: key("knowledge/billing/ledger.md"),
        confidence: 0.9,
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validTo: new Date("2026-06-30T12:00:00.000Z"),
        source: "https://example.com/rfc/7",
        observedAt: OBSERVED,
      },
      // No chunk links to the rates file, so the claim takes the first chunk.
      expect.objectContaining({
        srcChunk: 0,
        predicate: "USES",
        dstDoc: key("knowledge/payments/rates.md"),
        confidence: 0.5,
        validFrom: new Date("2026-02-03T04:05:06.000Z"),
        validTo: null,
      }),
      expect.objectContaining({
        srcChunk: 1,
        predicate: "LINKS_TO",
        dstDoc: key("knowledge/billing/ledger.md"),
      }),
    ])
  })

  it("maps an image to an image document whose key comes from the hash only", () => {
    const path = "knowledge/arch/overview.md"
    const keyLike = `knowledge/arch/org_x/ws_y/${"b".repeat(64)}.png`
    const content = [
      "# Overview",
      "",
      "The system.",
      "",
      "## Diagram",
      "",
      '![Request flow](../../assets/flow.png "The flow")',
      "![Again](../../assets/flow.png)",
      `![Other org](org_x/ws_y/${"b".repeat(64)}.png)`,
      "![Remote](https://example.com/remote.png)",
      "![Not an image](./notes.md)",
      "",
    ].join("\n")
    const rows = rowsOf(
      [{ path, content }],
      path,
      new Map<string, string | null>([
        ["assets/flow.png", HASH],
        [keyLike, null],
      ]),
    )
    const image = key("assets/flow.png")
    expect(rows.slice(1)).toEqual([
      {
        document: {
          docKey: image,
          kind: "image",
          status: "active",
          deletedAt: null,
          error: "",
          title: "flow.png",
          path: "assets/flow.png",
          sourceType: "docs",
          source: "",
          summary: "",
          s3Key: `{org_id}/{workspace_id}/${HASH}`,
          mime: "image/png",
          validFrom: null,
          validTo: null,
          observedAt: OBSERVED,
        },
        chunks: [{ ordinal: 0, text: "", startLine: 0, endLine: 0 }],
        relations: [],
      },
    ])
    // The key-like path in the content gets a relation to its own document
    // key, but no image document, because Git has no such file. The Markdown
    // file stays a link.
    expect(edges(rows[0]?.relations ?? [])).toEqual([
      {
        predicate: "LINKS_TO",
        dstDoc: key("knowledge/arch/notes.md"),
        srcChunk: 1,
      },
      { predicate: "EMBEDS_IMAGE", dstDoc: image, srcChunk: 1 },
      { predicate: "EMBEDS_IMAGE", dstDoc: key(keyLike), srcChunk: 1 },
    ])
  })

  it("maps a body link with a title to the key and the chunk of its path", () => {
    const path = "knowledge/payments/api.md"
    const [rows] = rowsOf(
      [
        {
          path,
          content:
            '# API\n\nIntro.\n\n## Ledger\n\nSee [ledger](../billing/ledger.md "Ledger") and [it](../billing/ledger.md).\n',
        },
      ],
      path,
    )
    expect(edges(rows?.relations ?? [])).toEqual([
      {
        predicate: "LINKS_TO",
        dstDoc: key("knowledge/billing/ledger.md"),
        srcChunk: 1,
      },
    ])
  })

  it("gives a file with only front matter one chunk with its title, so each relation has a chunk", () => {
    const path = "knowledge/services/api.md"
    const [rows] = rowsOf(
      [
        {
          path,
          content: `---\n${stringify({
            title: "Payments API",
            claims: [{ to: "../billing/ledger.md", predicate: "DEPENDS_ON" }],
          })}---\n`,
        },
      ],
      path,
    )
    expect(rows?.chunks).toEqual([
      { ordinal: 0, text: "Payments API", startLine: 1, endLine: 1 },
    ])
    expect(edges(rows?.relations ?? [])).toEqual([
      {
        predicate: "DEPENDS_ON",
        dstDoc: key("knowledge/billing/ledger.md"),
        srcChunk: 0,
      },
    ])
  })

  it("maps an SVG reference to an image document with its type", () => {
    const path = "knowledge/arch/a.md"
    const rows = rowsOf(
      [{ path, content: "![Architecture](diagram.svg)\n" }],
      path,
      new Map([["knowledge/arch/diagram.svg", HASH]]),
    )
    expect(rows[1]?.document).toMatchObject({
      kind: "image",
      path: "knowledge/arch/diagram.svg",
      mime: "image/svg+xml",
      s3Key: `{org_id}/{workspace_id}/${HASH}`,
    })
  })

  it("maps a reference-style image to its image document", () => {
    const path = "knowledge/arch/a.md"
    const content = [
      "# A",
      "",
      "Intro.",
      "",
      "## Pictures",
      "",
      "![Flow][flow] ![map][] ![MAP]",
      "",
      '[flow]: ./flow.png "The flow"',
      "[map]: <./map.webp>",
      "",
    ].join("\n")
    const rows = rowsOf(
      [{ path, content }],
      path,
      new Map([
        ["knowledge/arch/flow.png", HASH],
        ["knowledge/arch/map.webp", HASH],
      ]),
    )
    expect(rows.map((entry) => entry.document.path)).toEqual([
      path,
      "knowledge/arch/flow.png",
      "knowledge/arch/map.webp",
    ])
    expect(
      edges(rows[0]?.relations ?? []).filter(
        (edge) => edge.predicate === "EMBEDS_IMAGE",
      ),
    ).toEqual([
      {
        predicate: "EMBEDS_IMAGE",
        dstDoc: key("knowledge/arch/flow.png"),
        srcChunk: 1,
      },
      {
        predicate: "EMBEDS_IMAGE",
        dstDoc: key("knowledge/arch/map.webp"),
        srcChunk: 1,
      },
    ])
  })

  it("refuses an image hash that is not a SHA-256 hex digest", () => {
    const path = "knowledge/a.md"
    expect(() =>
      rowsOf(
        [{ path, content: "![x](x.png)\n" }],
        path,
        new Map([["knowledge/x.png", "../../other-org/key"]]),
      ),
    ).toThrow("not a SHA-256 hex digest")
  })

  it("keeps the spaces of an image path in angle brackets", () => {
    const path = "knowledge/a.md"
    const content =
      '![Flow](<./request flow.png> "Flow") ![Map][map]\n\n[map]: <./site map.png>\n'
    const rows = rowsOf(
      [{ path, content }],
      path,
      new Map([
        ["knowledge/request flow.png", HASH],
        ["knowledge/site map.png", HASH],
      ]),
    )
    expect(rows.map((entry) => entry.document.path)).toEqual([
      path,
      "knowledge/request flow.png",
      "knowledge/site map.png",
    ])
  })

  it("ignores image syntax in fenced code", () => {
    const path = "knowledge/a.md"
    const content = [
      "# A",
      "",
      "````md",
      "![x](x.png) ![y][y]",
      "```",
      "![z](z.png)",
      "[w]: ./w.png",
      "````",
      "",
      "![w]",
      "[y]: ./y.png",
      "",
    ].join("\n")
    const rows = rowsOf(
      [{ path, content }],
      path,
      new Map(
        ["w.png", "x.png", "y.png", "z.png"].map((name): [string, string] => [
          `knowledge/${name}`,
          HASH,
        ]),
      ),
    )
    expect(rows).toHaveLength(1)
    expect(
      rows[0]?.relations.filter((edge) => edge.predicate === "EMBEDS_IMAGE"),
    ).toEqual([])
  })

  it("gives the same rows in the same order for the same input", () => {
    const files = [
      {
        path: "knowledge/payments/api.md",
        content:
          "---\nclaims:\n  - to: ../billing/ledger.md\n    predicate: DEPENDS_ON\n  - to: ./b.md\n---\n# API\n\nSee [ledger](../billing/ledger.md) and [b](./b.md).\n\n## Pictures\n\n![one](one.png) ![two](two.webp)\n",
      },
    ]
    const hashes = () =>
      new Map([
        ["knowledge/payments/two.webp", "2".repeat(64)],
        ["knowledge/payments/one.png", "1".repeat(64)],
      ])
    const first = rowsOf(files, "knowledge/payments/api.md", hashes())
    const second = rowsOf(
      structuredClone(files),
      "knowledge/payments/api.md",
      hashes(),
    )
    expect(second).toEqual(first)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(first.map((rows) => rows.document.path)).toEqual([
      "knowledge/payments/api.md",
      "knowledge/payments/one.png",
      "knowledge/payments/two.webp",
    ])
  })

  it.each([
    ["decisions/ADR-001-use-postgres.md", "# Use Postgres\n", "adr"],
    ["knowledge/queue.md", "---\nkind: Decision\n---\nUse a queue.\n", "adr"],
    [
      "github/pulls/acme/app/12.md",
      "---\nstate: closed\nmerged: true\n---\nBody.\n",
      "merged-pr",
    ],
    [
      "github/pulls/acme/app/13.md",
      "---\nstate: open\nmerged: false\n---\nBody.\n",
      "open-pr",
    ],
    [
      "github/pulls/acme/app/14.md",
      "---\nstate: closed\nmerged: false\n---\nBody.\n",
      "open-pr",
    ],
    ["knowledge/payments/api.md", "The API.\n", "docs"],
    ["notion/pages/roadmap.md", "Roadmap.\n", "docs"],
    ["confluence/spaces/eng/page.md", "Page.\n", "docs"],
    ["github/issues/acme/app/7.md", "Issue.\n", "issue"],
    ["linear/issues/ENG-1.md", "Issue.\n", "issue"],
    ["plain/threads/t1.md", "Thread.\n", "issue"],
    ["pagerduty/incidents/p1.md", "Incident.\n", "issue"],
    ["slack/channels/general/2026-11-19.md", "Hello.\n", "chat"],
    ["buildkite/builds/b1.md", "Build.\n", "other"],
    ["github/discussions/acme/app/1.md", "Body.\n", "other"],
  ])("stores the source authority kind of %s", (path, content, expected) => {
    const [row] = rowsOf([{ path, content }], path)
    expect(row?.document.sourceType).toBe(expected)
  })
})
