import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
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

/** A Git repository in `dir` with `fixture` committed. Gives its path and SHA. */
function commitFixture(
  dir: string,
  fixture: Record<string, string>,
): { repo: string; sha: string } {
  const repo = join(dir, "context")
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim()
  for (const [path, text] of Object.entries(fixture)) {
    mkdirSync(join(repo, path, ".."), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  git("init", "-q")
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
  return { repo, sha: git("rev-parse", "HEAD") }
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

describe("the documents of a clone", () => {
  it("reads each document below the root of the Workspace, with paths relative to it", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-documents-"))
    try {
      const { repo, sha } = commitFixture(dir, {
        "context/knowledge/apis/a.md": "# A\n\nOne.\n",
        "context/b.md": "# B\n\nTwo.\n",
        "outside.md": "# Outside\n",
      })
      const loaded = loadDocuments(repo, sha, "context")
      expect(
        loaded.map((document) => [document.path, document.title]).sort(),
      ).toEqual([
        ["b.md", "B"],
        ["knowledge/apis/a.md", "A"],
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
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

  it("asks about design records, owner teams and feature gates in turns with the other documents (CTX-1589)", () => {
    const newKinds: Record<string, string> = {
      "knowledge/decisions/kep-3-queue-order.md": `---
kind: Decision
name: "KEP-3: Queue order"
summary: The queue takes the oldest job first.
claims:
  - to: ./kep-4-fair-queue.md
    predicate: SUPERSEDED_BY
---

# KEP-3: Queue order

**Status:** Superseded
**Date:** 2023-01-01

${filler("oldest first")} This KEP is superseded by KEP-4.`,
      "knowledge/decisions/kep-4-fair-queue.md": `---
kind: Decision
name: "KEP-4: Fair queue"
summary: The queue takes the jobs of each tenant in turns.
---

# KEP-4: Fair queue

**Status:** Implementable
**Date:** 2024-01-01

${filler("tenant turns")}`,
      "knowledge/features/fairqueue.md": `---
kind: FeatureGate
name: FairQueue
summary: The feature gate of the fair queue.
claims:
  - to: ../services/scheduler.md
    predicate: PART_OF
---

# FairQueue

${filler("gate")}`,
      "knowledge/teams/kubernetes-sig-scheduling-approvers.md": `---
kind: Team
name: kubernetes/sig-scheduling-approvers
summary: The approvers of the scheduler.
claims:
  - to: ../services/scheduler.md
    predicate: OWNS
---

# kubernetes/sig-scheduling-approvers

${filler("approvers")}`,
      "github/issues/kubernetes/kubernetes/11.md": `---
type: issue
repository: kubernetes/kubernetes
title: Jobs of one tenant wait forever
state: open
stateReason: null
author: fourth-author
createdAt: 2024-07-01T00:00:00Z
labels: []
---

# Jobs of one tenant wait forever

${filler("tenant wait")} With FairQueue on, the jobs of one tenant wait.`,
    }
    const all = { ...files, ...newKinds }
    const allPaths = new Set(Object.keys(all))
    const picks = pickSources(
      Object.entries(all).map(([path, text]) =>
        parseDocument(path, text, allPaths),
      ),
      "seed",
    )
    const of = (category: string) =>
      picks
        .filter((pick) => pick.category === category)
        .map((pick) => pick.sources.map((source) => source.path))
    const isNew = (path: string) =>
      /^knowledge\/(?:decisions|teams|features)\//.test(path)
    const holdsNew = (paths: string[]) => paths.some(isNew)
    // A lookup of a new kind, then another, in turns while both last.
    const lookups = of("lookup")
    expect(lookups.slice(0, 6).map(holdsNew)).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
    ])
    // A feature gate is a part of the code: an issue that names it pairs
    // with it, and that pair comes first.
    expect(of("cross-source")[0]).toEqual([
      "github/issues/kubernetes/kubernetes/11.md",
      "knowledge/features/fairqueue.md",
    ])
    // A decision document is a design record: a dated one is a time
    // source, and a superseded one is a disagreement anchor.
    expect(of("time").flat()).toContain(
      "knowledge/decisions/kep-3-queue-order.md",
    )
    expect(of("disagreement")).toContainEqual([
      "knowledge/decisions/kep-3-queue-order.md",
      "knowledge/decisions/kep-4-fair-queue.md",
    ])
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
  /** The 429 answers before the next answers, each with its Retry-After. */
  let limited: (string | null)[] = []
  /** The next answers that refuse the call (HTTP 403, a moderation flag). */
  let refuseAt = new Set<number>()
  /** The requests that get another 403: the spent budget, or no reason. */
  let forbidAt = new Map<number, { error: { code: number; message: string } }>()
  let requests = 0
  const draftOf = (fields: Record<string, unknown>) => ({
    usable: true,
    reason: "",
    // No term of the fixture documents: a keyword search finds nothing.
    text: "Which component dispatches backlog items?",
    gold: [],
    keyFacts: ["The oldest job goes first."],
    date: "",
    positions: [],
    ...fields,
  })
  useMswServer(
    http.post(`${BASE}/chat/completions`, async ({ request }) => {
      requests++
      if (forbidAt.has(requests))
        return HttpResponse.json(forbidAt.get(requests), { status: 403 })
      if (refuseAt.has(requests)) {
        return HttpResponse.json(
          {
            error: {
              code: 403,
              message:
                "anthropic/drafter requires moderation. Your input was flagged: the secret words of the input.",
              metadata: {
                // A value that is no known category can echo the input.
                reasons: ["violence", "the secret words of the input"],
                flagged_input: "the secret words of the input",
                provider_name: "Amazon Bedrock",
              },
            },
          },
          { status: 403 },
        )
      }
      if (limited.length > 0) {
        const retryAfter = limited.shift()
        return HttpResponse.json(
          { error: "rate limited" },
          {
            status: 429,
            headers:
              typeof retryAfter === "string"
                ? { "retry-after": retryAfter }
                : {},
          },
        )
      }
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
                date: "2024-01-01T00:00:00Z",
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
  })

  it("stops at a failed call, and keeps the drafts before it", async () => {
    bodies.length = 0
    capAt = 2
    answer = (_category, sources) => ({ gold: sources })
    try {
      // A failed call is no draft to drop: the corpus stops there.
      const drafted = await run()
      expect(drafted.failed).toBe(
        "OpenRouter answered 503 for anthropic/drafter.",
      )
      expect(drafted.stopped).toBe(false)
      expect(drafted.questions).toHaveLength(2)
      // The pick with no answer is not an attempt: a resume tries it.
      expect(drafted.attempts).toHaveLength(2)
      expect(drafted.attempts.every((attempt) => attempt.kept)).toBe(true)
    } finally {
      capAt = Number.POSITIVE_INFINITY
    }
  })

  it("resumes a draft after its attempts, and refuses a draft of other picks", async () => {
    answer = (_category, sources) => ({ gold: sources })
    bodies.length = 0
    const whole = await run()
    bodies.length = 0
    capAt = 3
    let first: Awaited<ReturnType<typeof run>>
    try {
      first = await run()
    } finally {
      capAt = Number.POSITIVE_INFINITY
    }
    expect(first.failed).toBeDefined()
    bodies.length = 0
    const resumed = await run({ resume: first })
    // The same drafts as a draft with no failure, and no pick drafted twice.
    expect(resumed.failed).toBeUndefined()
    expect(resumed.questions.map((question) => question.id)).toEqual(
      whole.questions.map((question) => question.id),
    )
    expect(bodies).toHaveLength(whole.attempts.length - first.attempts.length)
    await expect(run({ seed: "another", resume: first })).rejects.toThrow(
      /has another pick/,
    )
  })

  it("skips a pick that OpenRouter refuses, keeps no text of the input, and stops at a second refusal in a row", async () => {
    answer = (category, sources) =>
      category === "lookup"
        ? { gold: sources }
        : { usable: false, reason: "skip" }
    requests = 0
    refuseAt = new Set([1])
    try {
      const drafted = await run()
      const refused = drafted.attempts.filter((attempt) => attempt.refused)
      expect(refused).toHaveLength(1)
      expect(refused[0]?.refused).toEqual({
        code: 403,
        reasons: ["violence", "other"],
        provider: "Amazon Bedrock",
      })
      expect(JSON.stringify(drafted.attempts)).not.toContain("secret words")
      expect(drafted.failed).toBeUndefined()
      expect(drafted.questions.length).toBeGreaterThan(0)
      // Two refusals in a row, on two picks: the corpus stops.
      requests = 0
      refuseAt = new Set([1, 2])
      const twice = await run()
      expect(twice.failed).toBe(
        "OpenRouter refused the call for anthropic/drafter (403: violence, other).",
      )
      // The refusal that stops the corpus stays.
      expect(twice.failedRefusal).toEqual({
        code: 403,
        reasons: ["violence", "other"],
        provider: "Amazon Bedrock",
      })
      // An answer out of the schema between them is no refusal.
      requests = 0
      refuseAt = new Set([1, 3])
      const lookup = answer
      answer = (category, sources) =>
        requests === 2 ? { gold: 7 } : lookup(category, sources)
      expect((await run()).failed).toBeUndefined()
    } finally {
      refuseAt = new Set()
    }
  })

  it("stops the corpus at once when the workspace budget is spent, and fails at a 403 with no moderation category", async () => {
    answer = (_category, sources) => ({ gold: sources })
    try {
      requests = 0
      forbidAt = new Map([
        [
          2,
          {
            error: {
              code: 403,
              message:
                "Workspace daily budget of $30.00 exceeded. The budget resets at 2026-11-23T00:00:00Z.",
            },
          },
        ],
      ])
      const spent = await run()
      expect(spent.stopped).toBe(true)
      expect(spent.failed).toBeUndefined()
      expect(spent.budget).toEqual({
        limitUsd: 30,
        resetsAt: "2026-11-23T00:00:00Z",
      })
      // No pick is skipped: the pick with no answer is not an attempt.
      expect(spent.attempts).toHaveLength(1)
      expect(spent.attempts.some((attempt) => attempt.refused)).toBe(false)
      expect(requests).toBe(2)
      requests = 0
      forbidAt = new Map([
        [1, { error: { code: 403, message: "Forbidden: some text" } }],
      ])
      const plain = await run()
      expect(plain.failed).toBe(
        "OpenRouter answered 403 for anthropic/drafter.",
      )
      expect(plain.attempts).toEqual([])
    } finally {
      forbidAt = new Map()
    }
  })

  it("waits as a rate limit says, at most 3 times, and fails at a rate limit with no wait", async () => {
    answer = (category, sources) =>
      category === "lookup"
        ? { gold: sources }
        : { usable: false, reason: "skip" }
    // Two waits, then an answer.
    requests = 0
    limited = ["0", "0"]
    const waited = await run({ scale: 0.25 })
    expect(waited.failed).toBeUndefined()
    expect(waited.questions.length).toBeGreaterThan(0)
    // A fourth 429 after three waits fails the call.
    requests = 0
    limited = ["0", "0", "0", "0"]
    expect((await run({ scale: 0.25 })).failed).toBe(
      "OpenRouter answered 429 for anthropic/drafter.",
    )
    expect(requests).toBe(4)
    // No Retry-After, or a wait above 60 s: no wait.
    for (const retryAfter of [null, "61"]) {
      requests = 0
      limited = [retryAfter]
      expect((await run({ scale: 0.25 })).failed).toBe(
        "OpenRouter answered 429 for anthropic/drafter.",
      )
      expect(requests).toBe(1)
    }
    limited = []
  })

  it("needs a time question to give a date of the sources, and a key fact with a date or a release", async () => {
    answer = (category, sources) =>
      category !== "time"
        ? { usable: false, reason: "skip" }
        : sources[0]?.endsWith("enhancements/1.md")
          ? {
              gold: sources,
              text: "Which component dispatches backlog items in 2024?",
              date: "2024-01-01T00:00:00Z",
            }
          : { gold: sources, date: "" }
    const drafted = await run()
    expect(drafted.questions).toEqual([])
    const reasons = drafted.attempts.map((attempt) => attempt.reason)
    expect(reasons).toContain(
      "no key fact states a date or a release of the sources",
    )
    expect(reasons).toContain("the date is not an ISO date-time")
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

  it("waits at a rate limit through the recorder, and writes the draft also when a call fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-draft-cli-"))
    try {
      const { repo, sha } = commitFixture(dir, files)
      const frozen = join(dir, "frozen.json")
      writeFileSync(
        frozen,
        JSON.stringify({
          version: "0",
          corpora: [
            {
              ...corpus,
              contextRepo: {
                ...corpus.contextRepo,
                sha,
              },
            },
          ],
        }),
      )
      const out = join(dir, "draft.json")
      bodies.length = 0
      capAt = 2
      // A rate limit first: its wait passes through the recorder.
      limited = ["0"]
      answer = (_category, sources) => ({ gold: sources })
      vi.stubEnv("MODEL_PROVIDER", "openrouter")
      vi.stubEnv("MODEL_PROVIDER_URL", BASE)
      vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
      vi.stubEnv("MODEL_PROVIDER_ALLOWLIST", "azure")
      const args = [
        "--dataset",
        frozen,
        "--corpus",
        "demo",
        "--repo",
        repo,
        "--model",
        "anthropic/drafter",
      ]
      await expect(main(["draft", "--out", out, ...args])).rejects.toThrow(
        /OpenRouter answered 503/,
      )
      const written = JSON.parse(readFileSync(out, "utf8"))
      expect(written.questions).toHaveLength(2)
      const audit = JSON.parse(readFileSync(`${out}.attempts.json`, "utf8"))
      expect(audit.failed).toBe(
        "OpenRouter answered 503 for anthropic/drafter.",
      )
      // The resume drafts the rest of the corpus, and adds up the spend.
      capAt = Number.POSITIVE_INFINITY
      const next = join(dir, "draft-2.json")
      await expect(
        main(["draft", "--out", next, "--resume", out, ...args]),
      ).resolves.toBe(0)
      const resumed = JSON.parse(readFileSync(next, "utf8"))
      expect(resumed.questions.length).toBeGreaterThan(2)
      expect(resumed.questions.slice(0, 2)).toEqual(written.questions)
      const resumedAudit = JSON.parse(
        readFileSync(`${next}.attempts.json`, "utf8"),
      )
      expect(resumedAudit.failed).toBeUndefined()
      expect(resumedAudit.spentUsd).toBeGreaterThan(audit.spentUsd)
      // A resume with another scale has other picks: a setup error, before
      // any call.
      bodies.length = 0
      await expect(
        main([
          "draft",
          "--out",
          join(dir, "draft-3.json"),
          "--resume",
          out,
          "--scale",
          "0.5",
          ...args,
        ]),
      ).rejects.toThrow(/another seed or scale/)
      expect(bodies).toEqual([])
    } finally {
      capAt = Number.POSITIVE_INFINITY
      limited = []
      vi.unstubAllEnvs()
      rmSync(dir, { recursive: true, force: true })
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
