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
        "DELETE /api/v1/carts works, and POST `/carts` and PATCH `/items/` too.",
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
      ["op:DELETE /api/v1/carts", 0.9],
      ["op:GET /orders/{}", 0.9],
      ["op:PATCH /items", 0.9],
      ["op:POST /carts", 0.9],
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

/** A knowledge unit file of a kind and a name. */
const unitFile = (kind: string, name: string) =>
  `---\n${stringify({ kind, name })}---\n# ${name}\n`

/**
 * The names of the knowledge units that an issue mentions: the `MENTIONS`
 * links of the issue whose key is a key of a unit, as the read joins them.
 */
function mentionedUnits(
  text: { title: string; body: string },
  units: [kind: string, name: string][],
) {
  const { path, content } = issue(text)
  const linked = new Set(
    referencesOf(path, content)
      .links.filter((link) => link.predicate === "MENTIONS")
      .map((link) => link.key),
  )
  return units
    .filter(([kind, name], index) =>
      referencesOf(`knowledge/units/${index}.md`, unitFile(kind, name)).keys.some(
        (key) => linked.has(key),
      ),
    )
    .map(([, name]) => name)
}

describe("issue mentions in code and plain product names (CTX-1579)", () => {
  // Text from public issues of rust-lang/rust, backstage/backstage and
  // kubernetes/kubernetes.
  it("the root of a path in fenced code or a code span names a crate", () => {
    const units: [string, string][] = [
      ["Library", "build_helper"],
      ["Library", "run_make_support"],
      ["Library", "rustfix"],
      ["Service", "x"],
      ["Service", "git"],
    ]
    expect(
      mentionedUnits(
        {
          title: "`./x check` being killed may leave `.git/index.lock` file",
          body: [
            "Stack trace:",
            "```",
            "   7: build_helper::git::run_git_diff_index::<build_helper::git::changes_since::{closure#0}>",
            "   9: std::collections::hash::map::Entry::or_insert_with<enum2$<build_helper::git::PathFreshness>>",
            "```",
            "The test uses `x::run` and `rustfix::apply_suggestions` too.",
          ].join("\n"),
        },
        units,
      ),
    ).toEqual(["build_helper", "rustfix"])
    expect(
      mentionedUnits(
        {
          title: "Fingerprints of the full IR and the summary index differ",
          body: "```rust\nuse run_make_support::{llvm_bcanalyzer, rustc};\n```\n",
        },
        units,
      ),
    ).toEqual(["run_make_support"])
  })

  it("a method and a path name an operation in any case", () => {
    const units: [string, string][] = [
      ["Operation", "GET /entities"],
      ["Operation", "POST /entities"],
    ]
    expect(
      mentionedUnits(
        {
          title: "There is no ordering in the OwnerPicker",
          body: "Option B: add a default `orderFields` filter to the `catalog-backend.createRouter() get /entities`.",
        },
        units,
      ),
    ).toEqual(["GET /entities"])
  })

  it("a capitalized name of two or more words, and a word before API, name a unit", () => {
    const units: [string, string][] = [
      ["API", "Catalog API"],
      ["API", "Kubernetes API"],
      ["API", "Notifications API"],
      ["Database", "Amazon S3"],
      ["Database", "Google Cloud Storage"],
      ["API", "Scaffolder API"],
    ]
    expect(
      mentionedUnits(
        {
          title: "Improve the Software Template API Documentation",
          body: [
            "It would be great if it was more like what we have for the Catalog API.",
            "The notifications API accepts a payload.metadata field.",
            "Docs may go to cloud storage services such as Amazon S3 or Azure Blob Storage.",
            "The module sets impersonation headers when calling the kubernetes api to fetch.",
          ].join("\n"),
        },
        units,
      ),
    ).toEqual(["Catalog API", "Kubernetes API", "Notifications API", "Amazon S3"])
  })

  it("a common word, a short name or a generic phrase makes no edge", () => {
    const units: [string, string][] = [
      ["Infrastructure", "Kubernetes"],
      ["Infrastructure", "Docker"],
      ["Library", "api"],
      ["Library", "kind"],
      ["Service", "x"],
      ["Library", "metrics"],
      ["API", "Health API"],
    ]
    expect(
      mentionedUnits(
        {
          title: "Kubernetes: kubelet restarts the pod",
          body: [
            "Docker runs the node. The API returns 500, and this API is slow.",
            "Expected Behavior: the health of the pod is fine.",
            "```yaml",
            "kind: Pod",
            "metadata:",
            "  name: metrics",
            "```",
            "```",
            "x::main at std::panicking::panic",
            "```",
          ].join("\n"),
        },
        units,
      ),
    ).toEqual([])
  })
})
