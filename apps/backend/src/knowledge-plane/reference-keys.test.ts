import { describe, expect, it } from "vitest"
import { stringify } from "yaml"

import { shopIssue as issue, SHOP_SOURCE_PATH } from "../test/github-issue.js"
import { parseKnowledgeFile, workspaceBlobPath } from "./parse-file.js"

const SHOP = "https://github.com/acme/shop"

function referencesOf(
  path: string,
  content: string,
  sourceRepositories = new Map([[SHOP_SOURCE_PATH, SHOP]]),
) {
  const parsed = parseKnowledgeFile({
    workspaceId: "ws_mentions",
    blobPath: workspaceBlobPath("https://github.com/acme/context.git", ""),
    path,
    content,
    sourceRepositories,
  })
  if (parsed.kind !== "unit") throw new Error(`No unit: ${parsed.kind}`)
  return parsed.references
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
        "GET /orders/{orderId} and a call to /api/v1/orders or `/status/`.",
        "The `order-worker` also uses client-lib, not `x`, `db` or `HOME`.",
        "The page docs/guide/payment-service.md names no unit, nor @ops-team.",
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
      ["name:client-lib", 0.7],
      ["name:order-worker", 0.8],
      ["op:GET /orders/{}", 0.9],
      ["oppath:/api/v1/orders", 0.8],
      ["oppath:/status", 0.8],
    ])
  })

  it("a file path names the folders in the repository of the source of the issue, and a permalink in its own repository", () => {
    const { path, content } = issue({
      title: "Slow",
      body: "In a/b.ts and https://github.com/acme/other/blob/main/lib/c.ts#L3.",
    })
    const keys = (sources: Map<string, string>) =>
      referencesOf(path, content, sources)
        .links.filter((link) => link.predicate === "MENTIONS")
        .map((link) => link.key)
        .sort()
    expect(
      keys(new Map([[SHOP_SOURCE_PATH, "https://github.com/acme/fork"]])),
    ).toEqual([
      "changed:https://github.com/acme/fork#a",
      "changed:https://github.com/acme/other#lib",
    ])
  })

  it("a file that is not an issue mentions nothing", () => {
    expect(
      mentions("notes/a.md", "---\ntitle: A\n---\n# A\n\nSee `client-lib`.\n"),
    ).toEqual([])
  })
})
