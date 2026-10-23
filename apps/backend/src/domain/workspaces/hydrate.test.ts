import { describe, expect, it } from "vitest"
import { stringify } from "yaml"
import { renderGithubPullRequest } from "../../services/github/pull-request-mirror/converter.js"
import {
  applyEffectiveValidFromToUnits,
  displayNameFromAgentsMarkdown,
  hydrateKnowledgeTree,
  hydrateUnitsToProjectionClaims,
  servingIdForKnowledgePath,
} from "./hydrate.js"
import {
  computeWorkspaceGraphQuality,
  workspaceGraphNodes,
} from "./workspace-graph.js"

describe("hydrateKnowledgeTree unit metadata", () => {
  it("takes the title from front matter, else the first heading", () => {
    const { units } = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      files: [
        {
          path: "notes/front.md",
          content: "---\ntitle: Front title\n---\n# Heading title\nBody.\n",
        },
        {
          path: "notes/heading.md",
          content:
            "Intro line.\n\n```\n# not a heading\n```\n## Deep heading ##\nBody.\n",
        },
        { path: "notes/none.md", content: "No heading here.\n" },
      ],
    })
    expect(units.map(({ path, title }) => ({ path, title }))).toEqual([
      { path: "notes/front.md", title: "Front title" },
      { path: "notes/heading.md", title: "Deep heading" },
      { path: "notes/none.md", title: null },
    ])
  })

  it("sets source to the connector root or authored, and updatedAt from the last commit", () => {
    const { units } = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      files: [
        {
          path: "linear/issues/PAY-1.md",
          content: "# PAY-1\n",
          lastCommitTimestamp: "2026-01-02T03:04:05.000Z",
        },
        { path: "knowledge/payments.md", content: "# Payments\n" },
      ],
    })
    expect(
      units.map(({ path, source, updatedAt }) => ({ path, source, updatedAt })),
    ).toEqual([
      {
        path: "linear/issues/PAY-1.md",
        source: "linear",
        updatedAt: "2026-01-02T03:04:05.000Z",
      },
      { path: "knowledge/payments.md", source: "authored", updatedAt: null },
    ])
  })
})

describe("hydrateKnowledgeTree", () => {
  it("uses a stable serving id per Workspace + path and skips malformed files", () => {
    const a = servingIdForKnowledgePath("ws_1", "knowledge/payments/api.md")
    const b = servingIdForKnowledgePath("ws_1", "knowledge/payments/api.md")
    const c = servingIdForKnowledgePath("ws_2", "knowledge/payments/api.md")
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith("kn_")).toBe(true)

    const result = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      files: [
        {
          path: "knowledge/payments/api.md",
          content:
            "---\nclaims:\n  - to: ../billing/ledger.md\n    predicate: DEPENDS_ON\n---\nSee [ledger](../billing/ledger.md).\n",
        },
        { path: "broken.md", content: "---\nnot closed\n" },
        {
          path: "repositories/billing.md",
          content: "---\ngit: https://github.com/acme/billing.git\n---\n",
        },
        { path: "linear/issues/PAY-1.md", content: "mirror" },
      ],
    })
    expect(result.units).toHaveLength(2)
    expect(result.units.map((unit) => unit.path).sort()).toEqual([
      "knowledge/payments/api.md",
      "linear/issues/PAY-1.md",
    ])
    expect(
      result.units.find((unit) => unit.path === "knowledge/payments/api.md")
        ?.links,
    ).toEqual(["../billing/ledger.md"])
    expect(
      result.units.find((unit) => unit.path === "knowledge/payments/api.md")
        ?.claims[0]?.to,
    ).toBe("../billing/ledger.md")
    expect(
      result.units.find((unit) => unit.path === "knowledge/payments/api.md")
        ?.confidence,
    ).toBeNull()
    expect(result.skipped).toEqual([{ path: "broken.md", reason: "malformed" }])
    // A repository file is not a link and not a unit (ADR-050).
    expect(result.linked).toEqual([])
  })

  it("skips a Markdown file with unresolved merge markers, so search and the graph do not read it", () => {
    const result = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      files: [
        {
          path: "knowledge/payments/api.md",
          content:
            "---\ntitle: API\n---\n<<<<<<< default branch\nRetry 3 times.\n=======\nRetry 5 times.\n>>>>>>> ctxpipe write\n",
        },
        {
          path: "AGENTS.md",
          content:
            "<<<<<<< default branch\na\n=======\nb\n>>>>>>> ctxpipe write\n",
        },
        // A Setext heading underline alone is not a conflict.
        { path: "knowledge/guide.md", content: "Guide\n=======\n\nText.\n" },
      ],
    })
    expect(result.units.map((unit) => unit.path)).toEqual([
      "knowledge/guide.md",
    ])
    expect(result.skipped).toEqual([
      { path: "knowledge/payments/api.md", reason: "merge_conflict" },
      { path: "AGENTS.md", reason: "merge_conflict" },
    ])
  })

  it("does not skip a file that shows a conflict inside a fenced code block", () => {
    const example = "<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n"
    const result = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      files: [
        {
          path: "knowledge/git.md",
          content: `# Git\n\n\`\`\`diff\n${example}\`\`\`\n`,
        },
        {
          path: "knowledge/tilde.md",
          content: `# Git\n\n  ~~~text\n${example}~~~\n`,
        },
      ],
    })
    expect(result.skipped).toEqual([])
    expect(result.units.map((unit) => unit.path).sort()).toEqual([
      "knowledge/git.md",
      "knowledge/tilde.md",
    ])
  })

  it("skips a real conflict that follows a closed fenced code block", () => {
    const result = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      files: [
        {
          path: "knowledge/a.md",
          content:
            "```sh\nls\n```\n<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n",
        },
      ],
    })
    expect(result.skipped).toEqual([
      { path: "knowledge/a.md", reason: "merge_conflict" },
    ])
  })

  it("does not treat markers out of order as a conflict", () => {
    const result = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      files: [
        {
          path: "knowledge/a.md",
          content: ">>>>>>> theirs\n=======\n<<<<<<< ours\n",
        },
      ],
    })
    expect(result.skipped).toEqual([])
    expect(result.units).toHaveLength(1)
  })

  it("links only the repositories of GitHub sources, with their ref, once each", () => {
    const result = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      workspaceUrl: "https://github.com/acme/knowledge",
      files: [
        {
          path: "repositories/billing.md",
          content:
            "---\ngit: https://github.com/acme/legacy.git\nbranch: release\n---\n",
        },
      ],
      sourcesFile: [
        "version: 1",
        "sources:",
        "  - id: product-repos",
        "    provider: github",
        "    connection: con_github1",
        "    repositories: [{name: acme/billing, ref: release}, acme/web, acme/knowledge]",
        "  - id: again",
        "    provider: github",
        "    connection: con_github1",
        "    repositories: [acme/web]",
        "  - id: other-org",
        "    provider: github",
        "    connection: con_elsewhere",
        "    repositories: [acme/secret]",
      ].join("\n"),
      githubConnectionIds: new Set(["con_github1"]),
    })
    expect(result.linked).toEqual([
      {
        path: ".ctxpipe/sources.yaml",
        git: "https://github.com/acme/billing",
        branch: "release",
        connectionId: "con_github1",
      },
      {
        path: ".ctxpipe/sources.yaml",
        git: "https://github.com/acme/web",
        branch: null,
        connectionId: "con_github1",
      },
    ])
    expect(result.skipped).toEqual([])
  })

  it("links the repository of each GitHub source file, with the file as its path", () => {
    const files = [
      {
        path: "sources/github/acme/web.md",
        content:
          "---\nprovider: github\nconnection: con_github1\nrepository: acme/web\nref: main\n---\nThe web app.\n",
      },
      {
        path: "sources/github/acme/secret.md",
        content:
          "---\nprovider: github\nconnection: con_elsewhere\nrepository: acme/secret\n---\n",
      },
    ]
    const result = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      workspaceUrl: "https://github.com/acme/knowledge",
      files,
      sourceFiles: files.map((file) => ({
        path: file.path,
        text: file.content,
      })),
      githubConnectionIds: new Set(["con_github1"]),
    })
    expect(result.linked).toEqual([
      {
        path: "sources/github/acme/web.md",
        git: "https://github.com/acme/web",
        branch: "main",
        connectionId: "con_github1",
      },
    ])
  })

  it("links a repository from the source that held it at the previous revision", () => {
    const githubFile = (path: string, ref: string) => ({
      path,
      text: `---\nprovider: github\nconnection: con_github1\nrepository: acme/web\nref: ${ref}\n---\n`,
    })
    const sourceFiles = [
      githubFile("sources/github/acme/a.md", "next"),
      githubFile("sources/github/acme/b.md", "main"),
    ]
    const result = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      workspaceUrl: "https://github.com/acme/knowledge",
      files: sourceFiles.map((file) => ({
        path: file.path,
        content: file.text,
      })),
      sourceFiles,
      githubConnectionIds: new Set(["con_github1"]),
      previousSourceRows: [
        {
          sourceKey: "sources/github/acme/b.md",
          provider: "github",
          connectionId: "con_github1",
          scope: { repository: "acme/web", ref: "main" },
          status: "ok",
        },
      ],
    })
    expect(result.linked).toEqual([
      {
        path: "sources/github/acme/b.md",
        git: "https://github.com/acme/web",
        branch: "main",
        connectionId: "con_github1",
      },
    ])
  })

  it("keeps the ontology kind from front matter for the workspace graph", () => {
    const { units } = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      files: [
        {
          path: "knowledge/services/billing.md",
          content: "---\nkind: Service\n---\nBilling service.",
        },
        { path: "knowledge/notes/overview.md", content: "Plain notes." },
      ],
    })
    expect(units.map((unit) => unit.kind)).toEqual(["Service", null])
    expect(workspaceGraphNodes(units).map((node) => node.kind)).toEqual([
      "Service",
      "KnowledgeUnit",
    ])
  })
})

describe("applyEffectiveValidFromToUnits", () => {
  it("copies the introducing-commit timestamp onto git-SHA valid_from", () => {
    expect(
      applyEffectiveValidFromToUnits(
        [
          {
            path: "knowledge/a.md",
            servingId: "kn_a",
            title: null,
            source: "authored",
            updatedAt: null,
            body: "A",
            links: [],
            claims: [
              {
                to: "./b.md",
                predicate: "DEPENDS_ON",
                confidence: 0.8,
                validFrom: "abc123",
                validTo: null,
                source: "git",
              },
            ],
          },
        ],
        new Map([["knowledge/a.md", "2026-08-16T12:00:00.000Z"]]),
      )[0]?.claims[0]?.validFrom,
    ).toBe("2026-08-16T12:00:00.000Z")
  })
})

describe("hydrateUnitsToProjectionClaims", () => {
  it("projects layer-2 claims and unresolved-safe LINKS_TO from units", () => {
    const api = servingIdForKnowledgePath("ws_1", "knowledge/payments/api.md")
    const ledger = servingIdForKnowledgePath(
      "ws_1",
      "knowledge/billing/ledger.md",
    )
    const claims = hydrateUnitsToProjectionClaims(
      [
        {
          path: "knowledge/payments/api.md",
          servingId: api,
          title: null,
          source: "authored",
          updatedAt: null,
          body: "See [ledger](../billing/ledger.md).",
          links: ["../billing/ledger.md"],
          claims: [
            {
              to: "../billing/ledger.md",
              predicate: "DEPENDS_ON",
              confidence: 0.8,
              validFrom: "abc123",
              validTo: null,
              source: "git",
            },
          ],
        },
        {
          path: "knowledge/billing/ledger.md",
          servingId: ledger,
          title: null,
          source: "authored",
          updatedAt: null,
          body: "Ledger",
          links: [],
          claims: [],
        },
      ],
      "2026-08-16T12:00:00.000Z",
    )
    expect(claims).toEqual([
      expect.objectContaining({
        subjectId: api,
        objectId: ledger,
        predicate: "DEPENDS_ON",
        aggregatedConfidence: 0.8,
        validFrom: "2026-08-16T12:00:00.000Z",
      }),
      expect.objectContaining({
        subjectId: api,
        objectId: ledger,
        predicate: "LINKS_TO",
        aggregatedConfidence: 1,
        validFrom: null,
        validTo: null,
      }),
    ])
  })

  it("copies file-level confidence onto claims that omit it", () => {
    const parsed = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      files: [
        {
          path: "knowledge/instructions/local-memory.md",
          content:
            "---\nkind: InstructionUnit\nconfidence: 0.62\nclaims:\n  - to: ../skills/local-memory.md\n    predicate: MEMBER_OF_PRIMARY\n---\nBody\n",
        },
        {
          path: "knowledge/skills/local-memory.md",
          content: "---\nkind: Skill\n---\nSkill\n",
        },
      ],
    })
    expect(parsed.units[0]?.confidence).toBe(0.62)
    const claims = hydrateUnitsToProjectionClaims(parsed.units)
    expect(claims[0]?.aggregatedConfidence).toBe(0.62)
  })
})

describe("displayNameFromAgentsMarkdown", () => {
  it("reads a valid name and ignores malformed or empty files", () => {
    expect(displayNameFromAgentsMarkdown("---\nname: Docs\n---\n")).toBe("Docs")
    expect(displayNameFromAgentsMarkdown("---\nname:   \n---\n")).toBeNull()
    expect(displayNameFromAgentsMarkdown("---\nnot closed\n")).toBeNull()
    expect(displayNameFromAgentsMarkdown("# No front matter\n")).toBeNull()
  })
})

describe("computeWorkspaceGraphQuality", () => {
  it("counts multi-source units, orphans, kinds and predicates from projected claims", () => {
    const { units } = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      files: [
        {
          path: "knowledge/services/api.md",
          content: [
            "---",
            "kind: Service",
            "claims:",
            "  - to: ../billing/ledger.md",
            "    predicate: DEPENDS_ON",
            "    source: ../../linear/issues/PAY-1.md",
            "  - to: ../billing/ledger.md",
            "    predicate: REFERENCES",
            "    source: ../../slack/threads/c1.md",
            "---",
            "API.",
          ].join("\n"),
        },
        {
          path: "knowledge/billing/ledger.md",
          content: "---\nkind: Service\n---\nLedger.",
        },
        { path: "knowledge/notes/lonely.md", content: "Nobody links here." },
      ],
    })
    const quality = computeWorkspaceGraphQuality(
      units,
      hydrateUnitsToProjectionClaims(units),
    )
    expect(quality).toMatchObject({
      totalUnits: 3,
      totalClaims: 2,
      multiSourceUnits: 2,
      orphanUnits: 1,
      sourcedClaimRate: 1,
      kinds: { Service: 2, KnowledgeUnit: 1 },
      predicates: { DEPENDS_ON: 1, REFERENCES: 1 },
    })
    expect(quality.joinDensity).toBeCloseTo(2 / 3)
  })

  it("does not count a FROM_SOURCE edge for orphans or joins", () => {
    const { units } = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      files: [
        {
          path: "sources/github/acme/shop.md",
          content:
            "---\nprovider: github\nconnection: con_github1\nrepository: acme/shop\n---\n",
        },
        {
          path: "sources/linear/eng.md",
          content: "---\nprovider: linear\nconnection: con_linear1\n---\n",
        },
        {
          path: "knowledge/services/api.md",
          content: `---\n${stringify({
            sources: ["sources/github/acme/shop.md", "sources/linear/eng.md"],
            claims: [
              {
                to: "../notes/plain.md",
                predicate: "REFERENCES",
                source: "../../linear/issues/PAY-1.md",
              },
            ],
          })}---\nAPI.`,
        },
        { path: "knowledge/notes/plain.md", content: "Plain." },
      ],
    })
    const quality = computeWorkspaceGraphQuality(
      units,
      hydrateUnitsToProjectionClaims(units),
    )
    expect(quality).toMatchObject({
      totalUnits: 4,
      totalClaims: 3,
      multiSourceUnits: 0,
      orphanUnits: 2,
      predicates: { FROM_SOURCE: 2, REFERENCES: 1 },
    })
  })
})

describe("hydrateKnowledgeTree pull request changes", () => {
  const SHOP = "https://github.com/acme/shop"
  const MERGED_AT = "2026-09-01T10:00:00Z"

  function pullRequest(
    paths: (string | { path: string; previousPath: string })[],
    merge: { merged: boolean; mergedAt: string | null } = {
      merged: true,
      mergedAt: MERGED_AT,
    },
  ) {
    return renderGithubPullRequest({
      id: 9001,
      number: 42,
      repository: "acme/shop",
      url: `${SHOP}/pull/42`,
      title: "Change the checkout",
      body: "",
      state: "closed",
      draft: false,
      author: { login: "dev", type: "human" },
      base: { ref: "main", sha: "a".repeat(40) },
      head: { ref: "change", sha: "b".repeat(40) },
      reviewDecision: null,
      labels: [],
      requestedReviewers: [],
      createdAt: "2026-08-30T10:00:00Z",
      updatedAt: MERGED_AT,
      files: paths.map((file) =>
        typeof file === "string"
          ? { path: file, status: "modified" as const }
          : { ...file, status: "renamed" as const },
      ),
      reviews: [],
      comments: [],
      requiredChecks: [],
      ...merge,
    })
  }

  function unitFile(
    path: string,
    kind: string,
    extra: Record<string, unknown> = {},
  ) {
    return {
      path,
      content: `---\n${stringify({ kind, name: path, sources: [SHOP], generated_by: "ctxpipe-extract", ...extra })}---\n# ${path}\n`,
    }
  }

  const PACKAGES = [
    unitFile("knowledge/codebases/shop.md", "Repository"),
    unitFile("knowledge/services/api.md", "Service", { root: "apps/api" }),
    unitFile("knowledge/libraries/ui.md", "Library", { root: "packages/ui" }),
    unitFile("knowledge/apps/web.md", "App", { root: "apps/web" }),
    unitFile("knowledge/services/other-api.md", "Service", {
      root: "apps/api",
      sources: ["https://github.com/acme/other"],
    }),
  ]

  function changedEdges(
    paths: (string | { path: string; previousPath: string })[],
    merge?: Parameters<typeof pullRequest>[1],
    packages = PACKAGES,
  ) {
    const mirror = pullRequest(paths, merge)
    const { units } = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      files: [...packages, mirror],
    })
    const prUnit = units.find((unit) => unit.path === mirror.path)
    expect(prUnit?.kind).toBe("PullRequest")
    const pathOf = new Map(units.map((unit) => [unit.servingId, unit.path]))
    return hydrateUnitsToProjectionClaims(
      applyEffectiveValidFromToUnits(units, new Map()),
    )
      .filter((claim) => claim.predicate === "CHANGED")
      .map((claim) => ({
        from: pathOf.get(claim.subjectId),
        to: pathOf.get(claim.objectId),
        validFrom: claim.validFrom,
      }))
  }

  it("ignores a root on a hand-written unit", () => {
    expect(
      changedEdges(["apps/api/src/main.ts"], undefined, [
        unitFile("knowledge/services/manual.md", "Service", {
          root: "apps/api",
          generated_by: undefined,
        }),
      ]),
    ).toEqual([])
  })

  it.each([
    "",
    " ",
    "/",
    "/apps/api",
    "..",
    "apps/../api",
    ".git",
    "apps/.git/cache",
    "C:\\apps\\api",
  ])("ignores the invalid root %j", (root) => {
    expect(
      changedEdges(["apps/api/main.ts", `${root}/main.ts`], undefined, [
        unitFile("knowledge/services/invalid.md", "Service", { root }),
      ]),
    ).toEqual([])
  })

  it("ignores a root shared by multiple source repositories", () => {
    expect(
      changedEdges(["apps/api/main.ts"], undefined, [
        unitFile("knowledge/services/shared.md", "Service", {
          root: "apps/api",
          sources: [SHOP, "https://github.com/acme/other"],
        }),
      ]),
    ).toEqual([])
  })

  it("selects the deepest root for a changed file", () => {
    expect(
      changedEdges(["apps/api/worker/main.ts"], undefined, [
        ...PACKAGES,
        unitFile("knowledge/services/worker.md", "Service", {
          root: "apps/api/worker",
        }),
      ]),
    ).toEqual([
      {
        from: pullRequest([]).path,
        to: "knowledge/services/worker.md",
        validFrom: MERGED_AT,
      },
    ])
  })

  it("includes the previous package after a file rename", () => {
    expect(
      changedEdges([
        { path: "apps/web/main.ts", previousPath: "apps/api/main.ts" },
      ]),
    ).toEqual([
      {
        from: pullRequest([]).path,
        to: "knowledge/apps/web.md",
        validFrom: MERGED_AT,
      },
      {
        from: pullRequest([]).path,
        to: "knowledge/services/api.md",
        validFrom: MERGED_AT,
      },
    ])
  })

  it("ignores a package without a root", () => {
    expect(
      changedEdges(["main.ts"], undefined, [
        unitFile("knowledge/services/unrooted.md", "Service"),
      ]),
    ).toEqual([])
  })

  it("uses dot as the repository top", () => {
    expect(
      changedEdges(["README.md"], undefined, [
        ...PACKAGES,
        unitFile("knowledge/apps/top.md", "App", { root: "." }),
      ]),
    ).toEqual([
      {
        from: pullRequest([]).path,
        to: "knowledge/apps/top.md",
        validFrom: MERGED_AT,
      },
    ])
  })

  it("writes one CHANGED claim per package that a monorepo pull request touches", () => {
    const mirror = pullRequest([]).path
    expect(
      changedEdges([
        "apps/api/src/checkout.ts",
        "apps/api/src/cart.ts",
        "packages/ui/button.tsx",
      ]),
    ).toEqual([
      { from: mirror, to: "knowledge/services/api.md", validFrom: MERGED_AT },
      { from: mirror, to: "knowledge/libraries/ui.md", validFrom: MERGED_AT },
    ])
  })

  it("writes a CHANGED claim to the repository unit only for a file outside every root", () => {
    expect(changedEdges(["README.md", "apps/apiary/x.ts"])).toEqual([
      {
        from: pullRequest([]).path,
        to: "knowledge/codebases/shop.md",
        validFrom: MERGED_AT,
      },
    ])
  })

  it("resolves a source path in `sources` to the repository of its GitHub source file", () => {
    const source = {
      path: "sources/github/acme/shop.md",
      content:
        "---\nprovider: github\nconnection: con_github1\nrepository: acme/shop\n---\n",
    }
    expect(
      changedEdges(["apps/api/main.ts"], undefined, [
        source,
        unitFile("knowledge/services/api.md", "Service", {
          root: "apps/api",
          sources: ["sources/github/acme/shop.md"],
        }),
        unitFile("knowledge/services/elsewhere.md", "Service", {
          root: "apps/api",
          sources: ["sources/github/acme/missing.md"],
        }),
      ]),
    ).toEqual([
      {
        from: pullRequest([]).path,
        to: "knowledge/services/api.md",
        validFrom: MERGED_AT,
      },
    ])
  })

  it("gives a `./sources/` path both its FROM_SOURCE edge and its CHANGED match", () => {
    const mirror = pullRequest(["apps/api/main.ts"])
    const { units } = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      files: [
        {
          path: "sources/github/acme/shop.md",
          content:
            "---\nprovider: github\nconnection: con_github1\nrepository: acme/shop\n---\n",
        },
        unitFile("knowledge/services/api.md", "Service", {
          root: "apps/api",
          sources: [" ./sources/github/acme/shop.md "],
        }),
        mirror,
      ],
    })
    const pathOf = new Map(units.map((unit) => [unit.servingId, unit.path]))
    expect(
      hydrateUnitsToProjectionClaims(units)
        .filter((claim) => claim.predicate !== "LINKS_TO")
        .map((claim) => [
          pathOf.get(claim.subjectId),
          claim.predicate,
          pathOf.get(claim.objectId),
        ]),
    ).toEqual(
      expect.arrayContaining([
        [mirror.path, "CHANGED", "knowledge/services/api.md"],
        [
          "knowledge/services/api.md",
          "FROM_SOURCE",
          "sources/github/acme/shop.md",
        ],
      ]),
    )
  })

  it("writes a CHANGED claim to the Workflow file of each workflow file that the pull request changes", () => {
    const mirror = pullRequest([]).path
    const workflow = (path: string, extra: Record<string, unknown>) =>
      unitFile(path, "Workflow", extra)
    expect(
      changedEdges(
        [
          ".github/workflows/ci.yml",
          {
            path: ".github/workflows/deploy.yml",
            previousPath: ".github/workflows/release.yml",
          },
        ],
        undefined,
        [
          ...PACKAGES,
          workflow("knowledge/workflows/shop-ci.md", {
            workflow_file: ".github/workflows/ci.yml",
          }),
          workflow("knowledge/workflows/shop-release.md", {
            workflow_file: ".github/workflows/release.yml",
          }),
          workflow("knowledge/workflows/shop-lint.md", {
            workflow_file: ".github/workflows/lint.yml",
          }),
          // A file of another repository, and a file that a human wrote.
          workflow("knowledge/workflows/other-ci.md", {
            workflow_file: ".github/workflows/ci.yml",
            sources: ["https://github.com/acme/other"],
          }),
          workflow("knowledge/workflows/manual-ci.md", {
            workflow_file: ".github/workflows/ci.yml",
            generated_by: undefined,
          }),
        ],
      ),
    ).toEqual([
      { from: mirror, to: "knowledge/codebases/shop.md", validFrom: MERGED_AT },
      {
        from: mirror,
        to: "knowledge/workflows/shop-ci.md",
        validFrom: MERGED_AT,
      },
      {
        from: mirror,
        to: "knowledge/workflows/shop-release.md",
        validFrom: MERGED_AT,
      },
    ])
  })

  it("writes no CHANGED claim to a Workflow file outside knowledge/workflows/, with another workflow_file, or with two sources", () => {
    const mirror = pullRequest([]).path
    const workflow = (path: string, extra: Record<string, unknown>) =>
      unitFile(path, "Workflow", extra)
    expect(
      changedEdges([".github/workflows/ci.yml", "package.json"], undefined, [
        ...PACKAGES,
        workflow("knowledge/services/ci.md", {
          workflow_file: ".github/workflows/ci.yml",
        }),
        workflow("knowledge/workflows/manifest.md", {
          workflow_file: "package.json",
        }),
        workflow("knowledge/workflows/shared-ci.md", {
          workflow_file: ".github/workflows/ci.yml",
          sources: [SHOP, "https://github.com/acme/other"],
        }),
      ]),
    ).toEqual([
      { from: mirror, to: "knowledge/codebases/shop.md", validFrom: MERGED_AT },
    ])
  })

  it("writes no CHANGED claim for a pull request that is not merged", () => {
    expect(
      changedEdges(["apps/api/src/checkout.ts"], {
        merged: false,
        mergedAt: null,
      }),
    ).toEqual([])
  })
})

describe("hydrateKnowledgeTree source files", () => {
  const SOURCE =
    "---\nprovider: github\nconnection: con_github1\nrepository: acme/shop\n---\nThe shop.\n"

  it("projects each file under sources/ as a Source unit and each listed source as a FROM_SOURCE edge", () => {
    const { units } = hydrateKnowledgeTree({
      workspaceId: "ws_1",
      files: [
        { path: "sources/github/acme/shop.md", content: SOURCE },
        {
          path: "sources/linear/eng.md",
          content: "---\nprovider: linear\nconnection: con_linear1\n---\n",
        },
        {
          path: "knowledge/services/api.md",
          content: `---\n${stringify({
            kind: "Service",
            sources: [
              "sources/github/acme/shop.md",
              "./sources/linear/eng.md",
              "sources/github/acme/shop.md",
              "sources/github/acme/missing.md",
              "knowledge/notes/plain.md",
              "https://github.com/acme/shop",
              7,
            ],
          })}---\n# API\n`,
        },
        { path: "knowledge/notes/plain.md", content: "Plain notes." },
      ],
    })
    expect(
      units.map((unit) => [unit.path, unit.kind ?? null, unit.source]),
    ).toEqual([
      ["sources/github/acme/shop.md", "Source", "authored"],
      ["sources/linear/eng.md", "Source", "authored"],
      ["knowledge/services/api.md", "Service", "authored"],
      ["knowledge/notes/plain.md", null, "authored"],
    ])
    const pathOf = new Map(units.map((unit) => [unit.servingId, unit.path]))
    expect(
      hydrateUnitsToProjectionClaims(units).map((claim) => ({
        from: pathOf.get(claim.subjectId),
        to: pathOf.get(claim.objectId),
        predicate: claim.predicate,
        confidence: claim.aggregatedConfidence,
      })),
    ).toEqual([
      {
        from: "knowledge/services/api.md",
        to: "sources/github/acme/shop.md",
        predicate: "FROM_SOURCE",
        confidence: 1,
      },
      {
        from: "knowledge/services/api.md",
        to: "sources/linear/eng.md",
        predicate: "FROM_SOURCE",
        confidence: 1,
      },
    ])
  })
})
