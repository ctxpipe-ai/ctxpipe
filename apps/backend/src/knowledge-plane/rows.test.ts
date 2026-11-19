import { describe, expect, it } from "vitest"
import { stringify } from "yaml"

import {
  applyEffectiveValidFromToUnits,
  hydrateKnowledgeTree,
  servingIdForKnowledgePath,
} from "../domain/workspaces/hydrate.js"
import { knowledgeRows } from "./rows.js"

const WS = "ws_1"
const OBSERVED = "2026-11-19T10:00:00.000Z"
const key = (path: string) => servingIdForKnowledgePath(WS, path)
const HASH = "a".repeat(64)

function rowsOf(
  files: Array<{ path: string; content: string }>,
  path: string,
  imageHashes: ReadonlyMap<string, string> = new Map(),
) {
  const { units } = hydrateKnowledgeTree({ workspaceId: WS, files })
  const unit = units.find((entry) => entry.path === path)
  if (!unit) throw new Error(`no unit for ${path}`)
  return knowledgeRows({
    workspaceId: WS,
    unit,
    imageHashes,
    observedAt: OBSERVED,
  })
}

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
    const api = key("knowledge/payments/api.md")
    const ledger = key("knowledge/billing/ledger.md")
    expect(rows.documents).toEqual([
      {
        doc_id: api,
        status: "active",
        deleted_at: null,
        error: null,
        kind: "KnowledgeUnit",
        title: "api",
        path: "knowledge/payments/api.md",
        source_type: "authored",
        source: null,
        summary: "See [ledger](../billing/ledger.md).",
        s3_key: null,
        mime: null,
        valid_from: null,
        valid_to: null,
        observed_at: OBSERVED,
      },
    ])
    expect(rows.chunks).toEqual([
      { doc_id: api, ordinal: 0, text: "See [ledger](../billing/ledger.md)." },
    ])
    expect(rows.relations).toEqual([
      {
        src_doc: api,
        src_chunk: 0,
        predicate: "DEPENDS_ON",
        dst_doc: ledger,
        confidence: 0.5,
        valid_from: null,
        valid_to: null,
        source: null,
        observed_at: OBSERVED,
      },
      {
        src_doc: api,
        src_chunk: 0,
        predicate: "LINKS_TO",
        dst_doc: ledger,
        confidence: 1,
        valid_from: null,
        valid_to: null,
        source: "git",
        observed_at: OBSERVED,
      },
    ])
  })

  it("maps the kind and the FROM_SOURCE relations of a file that lists sources", () => {
    const rows = rowsOf(
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
    expect(rows.documents[0]).toMatchObject({ kind: "Service", title: "API" })
    expect(rows.chunks).toEqual([
      {
        doc_id: key("knowledge/services/api.md"),
        ordinal: 0,
        text: "API\n\n# API",
      },
    ])
    expect(
      rows.relations.map(({ predicate, dst_doc, src_chunk }) => ({
        predicate,
        dst_doc,
        src_chunk,
      })),
    ).toEqual([
      {
        predicate: "FROM_SOURCE",
        dst_doc: key("sources/github/acme/shop.md"),
        src_chunk: 0,
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
    const rows = knowledgeRows({
      workspaceId: WS,
      unit,
      imageHashes: new Map(),
      observedAt: OBSERVED,
    })
    expect(rows.chunks.map(({ ordinal, text }) => [ordinal, text])).toEqual([
      [0, "Limits\n\n# Limits\n\nDaily caps."],
      [
        1,
        "Limits > History\n\n## History\n\nThe [old ledger](../billing/ledger.md) set them.",
      ],
    ])
    expect(rows.relations).toEqual([
      {
        src_doc: key(path),
        src_chunk: 1,
        predicate: "SUPERSEDES",
        dst_doc: key("knowledge/billing/ledger.md"),
        confidence: 0.9,
        valid_from: "2026-01-01T00:00:00.000Z",
        valid_to: "2026-06-30T12:00:00.000Z",
        source: "https://example.com/rfc/7",
        observed_at: OBSERVED,
      },
      // No chunk links to the rates file, so the claim takes the first chunk.
      expect.objectContaining({
        src_chunk: 0,
        predicate: "USES",
        dst_doc: key("knowledge/payments/rates.md"),
        confidence: 0.5,
        valid_from: "2026-02-03T04:05:06.000Z",
        valid_to: null,
      }),
      expect.objectContaining({
        src_chunk: 1,
        predicate: "LINKS_TO",
        dst_doc: key("knowledge/billing/ledger.md"),
      }),
    ])
  })

  it("maps an image to an image document whose key comes from the hash only", () => {
    const path = "knowledge/arch/overview.md"
    const content =
      "# Overview\n\nThe system.\n\n## Diagram\n\n" +
      "![Request flow](../../assets/flow.png)\n" +
      "![Again](../../assets/flow.png)\n" +
      "![Other org](org_x/ws_y/" +
      "b".repeat(64) +
      ".png)\n" +
      "![Remote](https://example.com/remote.png)\n" +
      "![Not an image](./notes.md)\n"
    const rows = rowsOf(
      [{ path, content }],
      path,
      new Map([["assets/flow.png", HASH]]),
    )
    const image = key("assets/flow.png")
    expect(rows.documents.slice(1)).toEqual([
      {
        doc_id: image,
        status: "active",
        deleted_at: null,
        error: null,
        kind: "image",
        title: "flow.png",
        path: "assets/flow.png",
        source_type: "authored",
        source: null,
        summary: null,
        s3_key: `{org_id}/{workspace_id}/${HASH}`,
        mime: "image/png",
        valid_from: null,
        valid_to: null,
        observed_at: OBSERVED,
      },
    ])
    expect(rows.chunks.at(-1)).toEqual({
      doc_id: image,
      ordinal: 0,
      text: "Request flow",
    })
    // The key-like path in the content gets a relation to its own document
    // key, but no image document, because it has no hash. The Markdown file
    // stays a link.
    expect(
      rows.relations.map(({ predicate, dst_doc, src_chunk }) => ({
        predicate,
        dst_doc,
        src_chunk,
      })),
    ).toEqual([
      {
        predicate: "LINKS_TO",
        dst_doc: key("knowledge/arch/notes.md"),
        src_chunk: 1,
      },
      { predicate: "EMBEDS_IMAGE", dst_doc: image, src_chunk: 1 },
      {
        predicate: "EMBEDS_IMAGE",
        dst_doc: key(`knowledge/arch/org_x/ws_y/${"b".repeat(64)}.png`),
        src_chunk: 1,
      },
    ])
    expect(rows.documents.map((row) => row.s3_key)).toEqual([
      null,
      `{org_id}/{workspace_id}/${HASH}`,
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
    expect(first.documents.map((row) => row.path)).toEqual([
      "knowledge/payments/api.md",
      "knowledge/payments/one.png",
      "knowledge/payments/two.webp",
    ])
  })
})
