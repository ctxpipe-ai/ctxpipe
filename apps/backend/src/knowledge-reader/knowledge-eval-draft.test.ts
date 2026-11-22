import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { HttpResponse, http } from "msw"
import { describe, expect, it, vi } from "vitest"

import { main } from "../../evals/knowledge/cli.js"
import type { Corpus } from "../../evals/knowledge/dataset.js"
import {
  loadDocuments,
  parseDocument,
} from "../../evals/knowledge/documents.js"
import {
  draftQuestions,
  finalizeQuestions,
  pickSources,
} from "../../evals/knowledge/draft.js"
import { madeUpPrivateKey } from "../../test/made-up-key.js"
import { useMswServer } from "../../test/msw.js"

/*
 * The drafter of the question set (`draft.ts`): code picks the source
 * documents with a fixed seed, a model (msw) writes the draft, and code
 * checks it.
 */

const filler = (topic: string) =>
  `${topic} `.repeat(3) +
  "The work queue holds the pending jobs, and each worker takes the oldest job first. ".repeat(
    8,
  )

const files: Record<string, string> = {
  "knowledge/services/scheduler.md": `---
kind: Service
name: scheduler
summary: The scheduler of the demo codebase.
claims:
  - to: ../libraries/queue.md
    predicate: USES_LIBRARY
  - to: ../codebases/demo.md
    predicate: IMPLEMENTED_IN
---

# scheduler

${filler("scheduler")}`,
  "knowledge/libraries/queue.md": `---
kind: Library
name: queue
summary: The work queue library.
---

# queue

${filler("queue")} The [scheduler](../services/scheduler.md) uses it.`,
  "knowledge/codebases/demo.md": `---
kind: Codebase
name: demo
summary: The demo codebase.
---

# demo

The demo codebase has a scheduler and a work queue.`,
  "github/issues/kubernetes/enhancements/1.md": `---
type: issue
repository: kubernetes/enhancements
title: Old queue order
state: closed
stateReason: completed
author: first-author
assignees: [an-assignee]
createdAt: 2023-01-01T00:00:00Z
closedAt: 2024-01-01T00:00:00Z
labels: [stage/alpha]
---

# Old queue order

${filler("old order")} This proposal is superseded by https://github.com/kubernetes/enhancements/issues/2.

## Comments

### 2023-02-01T00:00:00Z · a-reviewer

Looks good.

### 2023-03-01T00:00:00Z · k8s-ci-robot

Bot text.`,
  "github/issues/kubernetes/enhancements/2.md": `---
type: issue
repository: kubernetes/enhancements
title: New queue order
state: open
stateReason: null
author: second-author
createdAt: 2024-01-01T00:00:00Z
labels: [stage/beta]
---

# New queue order

${filler("new order")} It replaces kubernetes/enhancements#1.`,
  "github/issues/kubernetes/kubernetes/10.md": `---
type: issue
repository: kubernetes/kubernetes
title: The scheduler takes the newest job first
state: closed
stateReason: completed
author: third-author
createdAt: 2024-05-01T00:00:00Z
closedAt: 2024-06-01T00:00:00Z
labels: []
---

# The scheduler takes the newest job first

${filler("scheduler queue")} See https://github.com/kubernetes/enhancements/issues/2.`,
}

const paths = new Set(Object.keys(files))
const documents = Object.entries(files).map(([path, text]) =>
  parseDocument(path, text, paths),
)

const corpus: Corpus = {
  id: "demo",
  source: "example/demo",
  contextRepo: {
    url: "https://example.test/demo-context",
    sha: "d".repeat(40),
    root: "",
  },
  workspace: "demo-v0",
}

describe("the documents of a corpus", () => {
  it("reads the claim links, the issue references and the handles", () => {
    const scheduler = documents.find(
      (document) => document.path === "knowledge/services/scheduler.md",
    )
    expect(scheduler?.links).toEqual([
      { to: "knowledge/libraries/queue.md", via: "USES_LIBRARY" },
      { to: "knowledge/codebases/demo.md", via: "IMPLEMENTED_IN" },
    ])
    const old = documents.find((document) => document.path.endsWith("/1.md"))
    expect(old?.group).toBe("issues/kubernetes/enhancements")
    expect(old?.links).toEqual([
      { to: "github/issues/kubernetes/enhancements/2.md", via: "reference" },
    ])
    expect(old?.issue?.closedAt).toBe("2024-01-01T00:00:00Z")
    expect(old?.comments).toEqual(["a-reviewer", "k8s-ci-robot"])
    // A short issue reference is a link that the stacks do not follow.
    expect(
      documents.find((document) => document.path.endsWith("enhancements/2.md"))
        ?.links,
    ).toEqual([
      {
        to: "github/issues/kubernetes/enhancements/1.md",
        via: "short-reference",
      },
    ])
    // A relative Markdown link is an edge, as in the stacks.
    expect(
      documents.find((document) => document.path.endsWith("queue.md"))?.links,
    ).toEqual([{ to: "knowledge/services/scheduler.md", via: "LINKS_TO" }])
    expect(old?.handles.sort()).toEqual([
      "a-reviewer",
      "an-assignee",
      "first-author",
      "k8s-ci-robot",
    ])
  })
})

describe("the commands that call a model", () => {
  it("stop at setup when no provider allowlist is set", async () => {
    vi.stubEnv("MODEL_PROVIDER_ALLOWLIST", "")
    try {
      for (const command of ["draft", "label", "hydrate", "run"])
        await expect(main([command, "--out", "/nowhere"])).rejects.toThrow(
          /^Set MODEL_PROVIDER_ALLOWLIST/,
        )
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe("the documents of a clone", () => {
  it("reads each document below the root of the Workspace, with paths relative to it", () => {
    const repo = mkdtempSync(join(tmpdir(), "eval-documents-"))
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
      git("init", "-q")
      mkdirSync(join(repo, "context/knowledge/apis"), { recursive: true })
      writeFileSync(join(repo, "context/knowledge/apis/a.md"), "# A\n\nOne.\n")
      writeFileSync(join(repo, "context/b.md"), "# B\n\nTwo.\n")
      writeFileSync(join(repo, "outside.md"), "# Outside\n")
      git("add", ".")
      git(
        "-c",
        "user.name=eval",
        "-c",
        "user.email=eval@example.test",
        "commit",
        "-q",
        "-m",
        "fixture",
      )
      const loaded = loadDocuments(repo, git("rev-parse", "HEAD"), "context")
      expect(
        loaded.map((document) => [document.path, document.title]).sort(),
      ).toEqual([
        ["b.md", "B"],
        ["knowledge/apis/a.md", "A"],
      ])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe("the picks", () => {
  it("gives the same order for the same seed, and follows the rule of each category", () => {
    const picks = pickSources(documents, "seed")
    expect(pickSources(documents, "seed")).toEqual(picks)
    const of = (category: string) =>
      picks
        .filter((pick) => pick.category === category)
        .map((pick) => pick.sources.map((source) => source.path))
    // No overview of a codebase: it is too wide for a question.
    expect(of("lookup").flat()).not.toContain("knowledge/codebases/demo.md")
    expect(of("lookup")).toHaveLength(5)
    // Chains of two hops whose end is not a neighbor of the start. The
    // pair scheduler → queue has no second hop.
    expect(of("multi-hop").sort()).toEqual([
      [
        "github/issues/kubernetes/enhancements/1.md",
        "github/issues/kubernetes/enhancements/2.md",
        "github/issues/kubernetes/kubernetes/10.md",
      ],
      [
        "github/issues/kubernetes/kubernetes/10.md",
        "github/issues/kubernetes/enhancements/2.md",
        "github/issues/kubernetes/enhancements/1.md",
      ],
    ])
    // An issue that names a part of the code, then the knowledge of that
    // part. Each issue is in one pair only.
    const crossSource = of("cross-source")
    expect(crossSource.length).toBeGreaterThan(0)
    for (const [issue, knowledge] of crossSource) {
      expect(issue).toMatch(/^github\/issues\//)
      expect(knowledge).toMatch(/^knowledge\/(?:services|libraries)\//)
    }
    expect(new Set(crossSource.map(([issue]) => issue)).size).toBe(
      crossSource.length,
    )
    expect(of("time").every((pick) => pick.length === 1)).toBe(true)
    // A KEP issue that another document replaces comes first.
    expect(of("disagreement")[0]?.[0]).toMatch(
      /^github\/issues\/kubernetes\/enhancements\//,
    )
    expect(new Set(of("no-answer").flat())).toEqual(
      new Set(["knowledge/codebases/demo.md"]),
    )
  })

  it("keeps the questions of each category up to its quota, and puts 40% of them into holdout, spread evenly", () => {
    const question = (id: string, category: "lookup" | "time") => ({
      id,
      corpus: "demo",
      category,
      split: "dev" as const,
      text: id,
      gold: ["a.md"],
      keyFacts: ["A fact."],
    })
    const kept = finalizeQuestions([
      ...["a", "b", "c", "d", "e"].map((id) => question(id, "lookup")),
      question("f", "time"),
      question("g", "time"),
    ]).map((item) => [item.id, item.split])
    // The quota of lookups is 4: the fifth is out.
    // 4 lookups give 2:2 and 2 time questions 1:1: the nearest to 40%.
    expect(kept).toEqual([
      ["a", "dev"],
      ["b", "holdout"],
      ["c", "dev"],
      ["d", "holdout"],
      ["f", "dev"],
      ["g", "holdout"],
    ])
  })
})

describe("the drafter", () => {
  const BASE = "https://drafter.test/v1"
  const bodies: {
    content: string
    provider: unknown
    category: string
    sources: string[]
  }[] = []
  /** The draft of the model for a category and its source paths. */
  let answer: (
    category: string,
    sources: string[],
  ) => Record<string, unknown> = () => ({})
  let capAt = Number.POSITIVE_INFINITY
  const draftOf = (fields: Record<string, unknown>) => ({
    usable: true,
    reason: "",
    // No term of the fixture documents: a keyword search finds nothing.
    text: "Which component dispatches backlog items?",
    gold: [],
    keyFacts: ["The oldest job goes first."],
    validAt: "",
    positions: [],
    ...fields,
  })
  useMswServer(
    http.post(`${BASE}/chat/completions`, async ({ request }) => {
      if (bodies.length >= capAt)
        return HttpResponse.json({ error: "capped" }, { status: 503 })
      const body = (await request.json()) as {
        messages: { content: string }[]
        provider: unknown
      }
      const content = body.messages[0]?.content ?? ""
      const category = /Category: ([a-z-]+)\./.exec(content)?.[1] ?? ""
      const sources = [
        ...content.matchAll(/Source document \d+ <data>(.*?)<\/data>/g),
      ].map((match) => match[1] ?? "")
      bodies.push({ content, provider: body.provider, category, sources })
      return HttpResponse.json({
        choices: [
          {
            message: {
              content: JSON.stringify(draftOf(answer(category, sources))),
            },
          },
        ],
      })
    }),
  )
  const env = {
    MODEL_PROVIDER_API_KEY: "fixture-only",
    MODEL_PROVIDER_URL: BASE,
  }
  const run = (input: Partial<Parameters<typeof draftQuestions>[0]> = {}) =>
    draftQuestions({
      corpus,
      documents,
      model: "anthropic/drafter",
      seed: "seed",
      env,
      stopped: () => false,
      ...input,
    })

  it("drafts the questions of each category, with seeds from the sources and the current position", async () => {
    bodies.length = 0
    answer = (category, sources) =>
      category === "disagreement"
        ? {
            gold: sources,
            positions: [
              { refs: [sources[0]], status: "superseded" },
              { refs: [sources[1]], status: "current" },
            ],
          }
        : category === "no-answer"
          ? { text: "Where is the billing service?", keyFacts: [] }
          : category === "time"
            ? {
                gold: sources,
                text: "Which component dispatches backlog items in 2024?",
                validAt: "2024-01-01T00:00:00Z",
                keyFacts: ["The change came on 2024-01-01."],
              }
            : { gold: sources }
    const drafted = await run()
    expect(drafted.stopped).toBe(false)
    const byCategory = (category: string) =>
      drafted.questions.filter((question) => question.category === category)
    // The picks of the small corpus end before the quotas.
    expect(byCategory("lookup")).toHaveLength(5)
    for (const question of byCategory("multi-hop"))
      expect(question.seeds).toEqual([question.gold[0]])
    for (const question of byCategory("disagreement")) {
      const current = question.positions?.find(
        (position) => position.status === "current",
      )
      expect(question.seeds).toEqual(current?.refs)
    }
    // The month of the date is in the text of the two KEP issues only. The
    // date stays in the question text: no validAt goes out.
    expect(byCategory("time").map((question) => question.gold)).toEqual(
      expect.arrayContaining([
        ["github/issues/kubernetes/enhancements/1.md"],
        ["github/issues/kubernetes/enhancements/2.md"],
      ]),
    )
    for (const question of byCategory("time"))
      expect(question.validAt).toBeUndefined()
    expect(byCategory("time")).toHaveLength(2)
    expect(
      drafted.attempts.find(
        (attempt) =>
          attempt.category === "time" &&
          attempt.sources[0]?.endsWith("kubernetes/10.md"),
      )?.reason,
    ).toBe("no source document has a date in 2024-01")
    for (const question of byCategory("no-answer")) {
      expect(question.gold).toEqual([])
      expect(question.keyFacts).toEqual([])
    }
    expect(byCategory("image")).toEqual([])
    // A no-answer prompt shows what the corpus holds, and the earlier
    // no-answer questions.
    const noAnswerPrompts = bodies.filter(
      (body) => body.category === "no-answer",
    )
    expect(noAnswerPrompts[0]?.content).toContain("Titles of other documents")
    expect(noAnswerPrompts[1]?.content).toContain(
      "Where is the billing service?",
    )
  })

  it("drops a draft that names a person of the corpus, gives a document it did not get, or misses a source", async () => {
    answer = (category, sources) =>
      category !== "lookup"
        ? { usable: false, reason: "no good question" }
        : sources[0]?.endsWith("enhancements/1.md")
          ? { gold: sources, text: "What did a-reviewer say about it?" }
          : sources[0]?.endsWith("queue.md")
            ? { gold: ["knowledge/other/unknown.md"] }
            : { gold: sources }
    const drafted = await run()
    const reasons = drafted.attempts
      .filter((attempt) => attempt.category === "lookup" && !attempt.kept)
      .map((attempt) => attempt.reason)
    expect(reasons).toEqual(
      expect.arrayContaining([
        "the text names a person of the corpus",
        "gold knowledge/other/unknown.md is not a given document",
      ]),
    )
    expect(drafted.questions.map((question) => question.category)).toEqual([
      "lookup",
      "lookup",
      "lookup",
    ])
    expect(
      drafted.attempts.find((attempt) => attempt.category === "multi-hop")
        ?.reason,
    ).toBe("not usable: no good question")
  })

  it("asks again when a keyword search finds the gold, and drops a question that leaks twice", async () => {
    bodies.length = 0
    answer = (category, sources) =>
      category !== "lookup"
        ? { usable: false, reason: "skip" }
        : sources[0]?.endsWith("scheduler.md")
          ? // The words of the document, also in the second answer.
            { gold: sources, text: "scheduler scheduler oldest job" }
          : bodies.at(-1)?.content.includes("Your first question was")
            ? { gold: sources }
            : { gold: sources, text: `${sources[0]} queue oldest job first` }
    const drafted = await run()
    const lookups = drafted.attempts.filter(
      (attempt) => attempt.category === "lookup",
    )
    expect(lookups.every((attempt) => attempt.calls === 2)).toBe(true)
    const scheduler = lookups.find((attempt) =>
      attempt.sources[0]?.endsWith("scheduler.md"),
    )
    expect(scheduler?.kept).toBe(false)
    expect(scheduler?.reason).toBe(
      "a keyword search finds the gold knowledge/services/scheduler.md",
    )
    expect(lookups.filter((attempt) => attempt.kept)).toHaveLength(4)
    // The second prompt names the leaked question and the found gold.
    const again = bodies.find((body) =>
      body.content.includes("Your first question was"),
    )
    expect(again?.content).toContain("in its top 5")
  })

  it("drafts a part of each quota for a pilot", async () => {
    answer = (category, sources) =>
      category === "lookup"
        ? { gold: sources }
        : { usable: false, reason: "skip" }
    const drafted = await run({ scale: 0.25 })
    // ceil(4 × 0.25 × 1.1) = 2.
    expect(drafted.questions).toHaveLength(2)
  })

  it("drops a draft out of the question schema or out of the answer schema, and stops at a failed call", async () => {
    let call = 0
    answer = (category, sources) => {
      call++
      return category !== "lookup"
        ? { usable: false, reason: "skip" }
        : call === 1
          ? { gold: sources, keyFacts: [""] }
          : call === 2
            ? { gold: 7 }
            : { gold: sources }
    }
    const drafted = await run()
    const reasons = drafted.attempts
      .filter((attempt) => attempt.category === "lookup")
      .map((attempt) => attempt.reason)
    expect(reasons[0]).toMatch(/^keyFacts\.0: /)
    expect(reasons[1]).toBe(
      "anthropic/drafter gave an answer out of the schema.",
    )
    // A failed call is no draft to drop: the command stops.
    capAt = 0
    try {
      await expect(run()).rejects.toThrow(/OpenRouter answered 503/)
    } finally {
      capAt = Number.POSITIVE_INFINITY
    }
  })

  it("needs a time question to give a date of the sources, and a key fact with a date or a release", async () => {
    answer = (category, sources) =>
      category !== "time"
        ? { usable: false, reason: "skip" }
        : sources[0]?.endsWith("enhancements/1.md")
          ? {
              gold: sources,
              text: "Which component dispatches backlog items in 2024?",
              validAt: "2024-01-01T00:00:00Z",
            }
          : { gold: sources, validAt: "" }
    const drafted = await run()
    expect(drafted.questions).toEqual([])
    const reasons = drafted.attempts.map((attempt) => attempt.reason)
    expect(reasons).toContain(
      "no key fact states a date or a release of the sources",
    )
    expect(reasons).toContain("validAt is not an ISO date-time")
  })

  it("needs each source document in the gold of a multi-hop question", async () => {
    answer = (category, sources) =>
      category === "multi-hop"
        ? { gold: sources.slice(0, 1) }
        : { usable: false, reason: "skip" }
    const drafted = await run()
    expect(drafted.questions).toEqual([])
    expect(
      drafted.attempts.find((attempt) => attempt.category === "multi-hop")
        ?.reason,
    ).toBe("the gold must hold each source document")
  })

  it("scrubs each source and sends the provider block of ADR-070", async () => {
    bodies.length = 0
    const key = madeUpPrivateKey(2048)
    answer = () => ({ usable: false, reason: "skip" })
    const secret = parseDocument(
      "knowledge/services/secret.md",
      `# secret\n\n${filler("secret")}\n${key}\n`,
      new Set(["knowledge/services/secret.md"]),
    )
    await run({ documents: [secret] })
    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) {
      expect(body.provider).toMatchObject({
        data_collection: "deny",
        zdr: true,
      })
      for (const line of key.split("\n").slice(1, -1))
        expect(body.content).not.toContain(line)
    }
  })

  it("stops at the spend cap and keeps the drafts before the stop", async () => {
    bodies.length = 0
    capAt = 2
    answer = (_category, sources) => ({ gold: sources })
    try {
      const drafted = await run({ stopped: () => bodies.length >= capAt })
      expect(drafted.stopped).toBe(true)
      expect(drafted.questions).toHaveLength(2)
    } finally {
      capAt = Number.POSITIVE_INFINITY
    }
  })
})
