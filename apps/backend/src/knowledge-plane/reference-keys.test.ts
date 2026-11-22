import { describe, expect, it } from "vitest"
import { stringify } from "yaml"

import { renderGithubIssue } from "../services/github/issue-mirror/converter.js"
import { parseKnowledgeFile, workspaceBlobPath } from "./parse-file.js"

const SHOP = "https://github.com/acme/shop"

function referencesOf(
  path: string,
  content: string,
  sourceRepositories = new Map<string, string>(),
) {
  const parsed = parseKnowledgeFile({
    workspaceId: "ws_mentions",
    blobPath: workspaceBlobPath("https://github.com/acme/context.git", ""),
    path,
    content,
    sourceRepositories,
  })
  if (parsed.kind !== "unit") throw new Error(`No unit: ${parsed.kind}`)
  return parsed.unit && parsed.references
}

/** A GitHub issue mirror file of acme/shop, as the issue sync writes it. */
function issue(input: { title: string; body: string; labels?: string[] }) {
  return renderGithubIssue({
    id: "I_1",
    number: 1,
    repository: "acme/shop",
    url: `${SHOP}/issues/1`,
    title: input.title,
    body: input.body,
    state: "open",
    stateReason: null,
    author: { login: "dev", type: "human" },
    labels: input.labels ?? [],
    assignees: [],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    closedAt: null,
    comments: [],
    commentsTotal: 0,
    closedBy: [],
  })
}

/** The `MENTIONS` links of a file as `[key, confidence]`, sorted. */
function mentions(path: string, content: string) {
  return referencesOf(path, content)
    .links.filter((link) => link.predicate === "MENTIONS")
    .map((link) => [link.key, link.confidence] as const)
    .sort(([a], [b]) => a.localeCompare(b))
}

describe("issue mentions (CTX-1502)", () => {
  it("a knowledge unit states the key of its name, and an operation also the keys of its method and path", () => {
    const unit = (kind: string, name: string) =>
      `---\n${stringify({ kind, name })}---\n# ${name}\n`
    expect(
      referencesOf("knowledge/libraries/a.md", unit("Library", "Client-Lib"))
        .keys,
    ).toEqual(["name:client-lib"])
    expect(
      referencesOf(
        "knowledge/operations/b.md",
        unit("Operation", "GET /orders/{orderId}/"),
      ).keys,
    ).toEqual([
      "name:get /orders/{orderid}/",
      "op:GET /orders/{}",
      "oppath:/orders/{}",
    ])
    // A unit of a kind that is not code knowledge states no name key.
    expect(
      referencesOf("knowledge/instructions/c.md", unit("InstructionUnit", "x"))
        .keys,
    ).toEqual([])
  })

  it("an issue mentions each path, operation, label, code span and specific name of its text, with the confidence of the rule", () => {
    const { path, content } = issue({
      title: "checkout: totals are wrong for each kind of order",
      labels: ["area/billing", "bug"],
      body: [
        "The cache in packages/client-lib/src/cache.ts is stale after",
        "GET /orders/{orderId} and a call to /api/v1/orders.",
        "The `order-worker` also uses client-lib, not `x`, `db` or `HOME`.",
        "The page docs/guide/payment-service.md names no unit.",
        "See https://example.com/docs/guide.md for the guide.",
        "It is not in ./local/config.yaml, k8s.io/client/x.go or HTTP/1.1.",
        "```",
        "panic at apps/api/main.go:12 in fence_only_name",
        "```",
      ].join("\n"),
    })
    expect(mentions(path, content)).toEqual([
      [`changed:${SHOP}#apps`, 0.9],
      [`changed:${SHOP}#apps/api`, 0.9],
      [`changed:${SHOP}#docs`, 0.9],
      [`changed:${SHOP}#docs/guide`, 0.9],
      [`changed:${SHOP}#packages`, 0.9],
      [`changed:${SHOP}#packages/client-lib`, 0.9],
      [`changed:${SHOP}#packages/client-lib/src`, 0.9],
      ["name:billing", 0.8],
      ["name:checkout", 0.7],
      ["name:client-lib", 0.7],
      ["name:order-worker", 0.8],
      ["op:GET /orders/{}", 0.9],
      ["oppath:/api/v1/orders", 0.8],
    ])
  })

  it("a file path takes the repositories of the sources of the issue", () => {
    const { path, content } = issue({ title: "Slow", body: "In a/b.ts." })
    const withSources = content.replace(
      "\n---\n",
      "\nsources:\n  - sources/github/acme/fork.md\n---\n",
    )
    const links = referencesOf(
      path,
      withSources,
      new Map([
        ["sources/github/acme/fork.md", "https://github.com/acme/fork"],
      ]),
    ).links.map((link) => link.key)
    expect(links).toContain("changed:https://github.com/acme/fork#a")
    expect(links).not.toContain(`changed:${SHOP}#a`)
  })

  it("a file that is not an issue mentions nothing", () => {
    expect(
      mentions("notes/a.md", "---\ntitle: A\n---\n# A\n\nSee `client-lib`.\n"),
    ).toEqual([])
  })
})
