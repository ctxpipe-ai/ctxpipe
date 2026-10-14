import { describe, expect, it } from "vitest"
import {
  type RelevanceNode,
  type RelevanceOptions,
  type RelevanceSignal,
  rankRelated,
} from "./graph-relevance.js"

const NOW = new Date("2026-10-01T00:00:00.000Z")

function node(
  id: string,
  kind = "note",
  extra: Partial<RelevanceNode> = {},
): RelevanceNode {
  return { id, kind, degree: null, ...extra }
}

function signal(
  from: string,
  to: string,
  confidence = 0.8,
  extra: Partial<RelevanceSignal> = {},
): RelevanceSignal {
  return {
    from,
    to,
    predicate: "LINKS_TO",
    confidence,
    validFrom: null,
    validTo: null,
    source: "git",
    ...extra,
  }
}

function rank(input: {
  nodes: RelevanceNode[]
  signals: RelevanceSignal[]
  seeds: string[]
  queryHits?: Array<{ id: string; score: number }>
  options?: RelevanceOptions
}) {
  return rankRelated({
    ...input,
    options: { now: NOW, diversity: 0, ...input.options },
  })
}

function byId(results: ReturnType<typeof rankRelated>) {
  return new Map(results.map((result) => [result.id, result]))
}

describe("rankRelated personalized PageRank", () => {
  it("gives the known stationary values on two linked nodes", () => {
    const results = byId(
      rank({
        nodes: [node("a"), node("b")],
        signals: [signal("a", "b")],
        seeds: ["a"],
        options: { restart: 0.15, includeSeeds: true },
      }),
    )
    // p_a = α + (1 − α) p_b and p_b = (1 − α) p_a, so p_a = 1 / (2 − α).
    expect(results.get("a")?.ppr).toBeCloseTo(1 / 1.85, 6)
    expect(results.get("b")?.ppr).toBeCloseTo(0.85 / 1.85, 6)
  })

  it("splits the walk by edge weight", () => {
    const results = byId(
      rank({
        nodes: [node("a"), node("b"), node("c")],
        signals: [
          signal("a", "b", 0.8, { predicate: "WEAK" }),
          signal("a", "c", 0.8, { predicate: "STRONG" }),
        ],
        seeds: ["a"],
        options: { restart: 0.15, predicateWeights: { WEAK: 1, STRONG: 3 } },
      }),
    )
    expect(results.get("b")?.ppr).toBeCloseTo((0.85 * 0.25) / 1.85, 6)
    expect(results.get("c")?.ppr).toBeCloseTo((0.85 * 0.75) / 1.85, 6)
  })

  it("sends the mass of a dead end back to the restart vector", () => {
    const results = byId(
      rank({
        nodes: [node("a"), node("b"), node("c")],
        signals: [signal("a", "b"), signal("b", "c")],
        seeds: ["a"],
        options: { restart: 0.15, direction: "out", includeSeeds: true },
      }),
    )
    // p_b = 0.85 p_a, p_c = 0.85 p_b, and the mass sums to 1.
    const pa = 1 / (1 + 0.85 + 0.85 ** 2)
    expect(results.get("a")?.ppr).toBeCloseTo(pa, 6)
    expect(results.get("b")?.ppr).toBeCloseTo(0.85 * pa, 6)
    expect(results.get("c")?.ppr).toBeCloseTo(0.85 ** 2 * pa, 6)
  })

  it("follows the edges against their direction for direction in", () => {
    const signals = [signal("a", "b")]
    const nodes = [node("a"), node("b")]
    expect(
      rank({ nodes, signals, seeds: ["b"], options: { direction: "out" } }),
    ).toEqual([])
    expect(
      rank({ nodes, signals, seeds: ["b"], options: { direction: "in" } }).map(
        (result) => result.id,
      ),
    ).toEqual(["a"])
  })

  it("leaves out the seeds unless includeSeeds is set", () => {
    const input = {
      nodes: [node("a"), node("b")],
      signals: [signal("a", "b")],
      seeds: ["a"],
    }
    expect(rank(input).map((result) => result.id)).toEqual(["b"])
    expect(
      rank({ ...input, options: { includeSeeds: true } }).map(
        (result) => result.id,
      ),
    ).toEqual(["a", "b"])
  })

  it("ignores a seed that is not in the explored nodes", () => {
    expect(
      rank({ nodes: [node("a")], signals: [], seeds: ["missing"] }),
    ).toEqual([])
  })
})

describe("rankRelated edge truth from decayWorkspaceSignal", () => {
  it("drops an edge whose signals are outside their valid window", () => {
    const results = rank({
      nodes: [node("s"), node("ended"), node("future"), node("live")],
      signals: [
        signal("s", "ended", 0.9, {
          validFrom: "2026-01-01T00:00:00.000Z",
          validTo: "2026-02-01T00:00:00.000Z",
        }),
        signal("s", "future", 0.9, { validFrom: "2027-01-01T00:00:00.000Z" }),
        signal("s", "live", 0.9),
      ],
      seeds: ["s"],
    })
    expect(results.map((result) => result.id)).toEqual(["live"])
  })

  it("combines the raw signals of one edge", () => {
    const results = byId(
      rank({
        nodes: [node("s"), node("one"), node("two")],
        signals: [
          signal("s", "one", 0.6),
          signal("s", "two", 0.6),
          signal("s", "two", 0.6, { source: "linear" }),
        ],
        seeds: ["s"],
      }),
    )
    expect(results.get("two")?.ppr).toBeGreaterThan(
      results.get("one")?.ppr ?? 0,
    )
  })

  it("decays an old signal of a short-lived source", () => {
    const results = byId(
      rank({
        nodes: [node("s"), node("chat"), node("doc")],
        signals: [
          signal("s", "chat", 0.9, {
            source: "slack",
            validFrom: "2026-07-01T00:00:00.000Z",
          }),
          signal("s", "doc", 0.9, {
            source: "git",
            validFrom: "2026-07-01T00:00:00.000Z",
          }),
        ],
        seeds: ["s"],
      }),
    )
    expect(results.get("doc")?.ppr).toBeGreaterThan(
      results.get("chat")?.ppr ?? 0,
    )
  })
})

describe("rankRelated hub penalty", () => {
  const nodes = [
    node("s"),
    node("leaf", "note", { degree: 1 }),
    node("hub", "note", { degree: 100 }),
  ]
  const signals = [signal("s", "leaf"), signal("s", "hub")]

  it("uses the stored degree of the node, not the returned edges", () => {
    const results = byId(
      rank({ nodes, signals, seeds: ["s"], options: { hubPenalty: 0.5 } }),
    )
    // degree^-0.5: 1 for the leaf, 0.1 for 100 raw signals.
    expect(
      (results.get("leaf")?.ppr ?? 0) / (results.get("hub")?.ppr ?? 1),
    ).toBeCloseTo(10, 6)
  })

  it("does not lower a query hit", () => {
    const results = byId(
      rank({
        nodes,
        signals,
        seeds: ["s"],
        queryHits: [{ id: "hub", score: 0.01 }],
        options: { hubPenalty: 0.5, queryWeight: 0.000001 },
      }),
    )
    // The hit also enters the restart vector, so the hub is not below the leaf.
    expect(results.get("hub")?.ppr).toBeGreaterThanOrEqual(
      results.get("leaf")?.ppr ?? 0,
    )
  })

  it("is off for the ownership intent", () => {
    const results = byId(
      rank({ nodes, signals, seeds: ["s"], options: { intent: "ownership" } }),
    )
    expect(results.get("hub")?.ppr).toBeCloseTo(
      results.get("leaf")?.ppr ?? 0,
      9,
    )
  })
})

describe("rankRelated authority and recency", () => {
  const decisions = [
    node("s"),
    node("accepted", "Decision", { status: "accepted" }),
    node("superseded", "Decision", { status: "superseded" }),
  ]
  const decisionSignals = [signal("s", "accepted"), signal("s", "superseded")]

  it("ranks an accepted decision above a superseded one", () => {
    expect(
      rank({ nodes: decisions, signals: decisionSignals, seeds: ["s"] }).map(
        (result) => result.id,
      ),
    ).toEqual(["accepted", "superseded"])
  })

  it("keeps the status out of a question about history", () => {
    const results = byId(
      rank({
        nodes: decisions,
        signals: decisionSignals,
        seeds: ["s"],
        options: { intent: "why" },
      }),
    )
    expect(results.get("superseded")?.ppr).toBeCloseTo(
      results.get("accepted")?.ppr ?? 0,
      9,
    )
  })

  const pullRequests = [
    node("s"),
    node("new", "PullRequest", {
      reviewDecision: "APPROVED",
      eventDate: "2026-09-20T00:00:00.000Z",
    }),
    node("old", "PullRequest", {
      reviewDecision: "APPROVED",
      eventDate: "2025-09-20T00:00:00.000Z",
    }),
  ]
  const prSignals = [signal("s", "new"), signal("s", "old")]

  it("ranks a recent pull request first for the change intent", () => {
    expect(
      rank({
        nodes: pullRequests,
        signals: prSignals,
        seeds: ["s"],
        options: { intent: "change" },
      }).map((result) => result.id),
    ).toEqual(["new", "old"])
  })

  it("uses recencyHalfLifeDays", () => {
    const results = byId(
      rank({
        nodes: pullRequests,
        signals: prSignals,
        seeds: ["s"],
        options: { intent: "change", recencyHalfLifeDays: 36_500 },
      }),
    )
    const ratio =
      (results.get("new")?.ppr ?? 0) / (results.get("old")?.ppr ?? 1)
    expect(ratio).toBeGreaterThan(1)
    expect(ratio).toBeLessThan(1.01)
  })
  it("dates a change edge by its validFrom, the merge date", () => {
    const ratio = (options: RelevanceOptions) => {
      const results = byId(
        rank({
          nodes: [node("s"), node("old-package"), node("new-package")],
          signals: [
            signal("s", "old-package", 0.8, {
              predicate: "CHANGED",
              validFrom: "2025-10-01T00:00:00.000Z",
            }),
            signal("s", "new-package", 0.8, {
              predicate: "CHANGED",
              validFrom: "2026-09-01T00:00:00.000Z",
            }),
          ],
          seeds: ["s"],
          options,
        }),
      )
      return (
        (results.get("new-package")?.ppr ?? 0) /
        (results.get("old-package")?.ppr ?? 1)
      )
    }
    // Recency: 2^(-30 / 90) against the floor 0.1 for one year.
    expect(ratio({ intent: "change" })).toBeCloseTo(
      ratio({ intent: "change", signalWeights: { recency: 0 } }) *
        (0.5 ** (30 / 90) / 0.1),
      6,
    )
  })
})

describe("rankRelated intent presets", () => {
  it("gives the intent predicates more weight", () => {
    const input = {
      nodes: [node("s"), node("team"), node("doc")],
      signals: [
        signal("s", "team", 0.8, { predicate: "OWNS" }),
        signal("s", "doc", 0.8),
      ],
      seeds: ["s"],
    }
    const general = byId(rank(input))
    expect(general.get("team")?.ppr).toBeCloseTo(general.get("doc")?.ppr ?? 0)
    const ownership = byId(rank({ ...input, options: { intent: "ownership" } }))
    expect(
      (ownership.get("team")?.ppr ?? 0) / (ownership.get("doc")?.ppr ?? 1),
    ).toBeCloseTo(3, 6)
  })

  it("ignores a predicate weight that is not a finite number of 0 or more", () => {
    const input = {
      nodes: [node("s"), node("team"), node("doc")],
      signals: [
        signal("s", "team", 0.8, { predicate: "OWNS" }),
        signal("s", "doc", 0.8),
      ],
      seeds: ["s"],
    }
    const expected = rank(input)
    for (const weight of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(
        rank({ ...input, options: { predicateWeights: { OWNS: weight } } }),
      ).toEqual(expected)
    }
  })

  it("lets predicateWeights replace a preset weight, and 0 removes the edge", () => {
    const results = rank({
      nodes: [node("s"), node("team"), node("doc")],
      signals: [
        signal("s", "team", 0.8, { predicate: "OWNS" }),
        signal("s", "doc", 0.8),
      ],
      seeds: ["s"],
      options: { intent: "ownership", predicateWeights: { OWNS: 0 } },
    })
    expect(results.map((result) => result.id)).toEqual(["doc"])
  })
})

describe("rankRelated query match", () => {
  const nodes = [node("s"), node("a"), node("b")]
  const signals = [signal("s", "a"), signal("s", "b")]

  it("scales the fusion score to 0..1 before the score formula", () => {
    const results = byId(
      rank({
        nodes,
        signals,
        seeds: ["s"],
        // Reciprocal rank fusion of two lists: at most 2 / 61.
        queryHits: [
          { id: "a", score: 2 / 61 },
          { id: "b", score: 1 / 61 },
        ],
        options: { queryWeight: 0.5 },
      }),
    )
    const a = results.get("a")
    const b = results.get("b")
    expect(a?.queryMatch).toBeCloseTo(1, 9)
    expect(b?.queryMatch).toBeCloseTo(0.5, 9)
    expect(a?.score).toBeCloseTo(
      (a?.ppr ?? 0) ** 0.5 * (0.1 + (a?.queryMatch ?? 0)) ** 0.5,
      12,
    )
    expect(b?.score).toBeCloseTo(
      (b?.ppr ?? 0) ** 0.5 * (0.1 + (b?.queryMatch ?? 0)) ** 0.5,
      12,
    )
    expect([...results.keys()]).toEqual(["a", "b"])
  })

  it("puts the query hits in the restart vector", () => {
    const far = {
      nodes: [node("s"), node("near"), node("mid"), node("far")],
      signals: [signal("s", "near"), signal("s", "mid"), signal("mid", "far")],
      seeds: ["s"],
    }
    const without = byId(rank(far))
    const withHit = byId(
      rank({
        ...far,
        queryHits: [{ id: "far", score: 0.03 }],
        options: { queryWeight: 0.5 },
      }),
    )
    expect(withHit.get("far")?.ppr).toBeGreaterThan(
      without.get("far")?.ppr ?? 0,
    )
  })

  it("uses the walk only without a query", () => {
    const results = rank({ nodes, signals, seeds: ["s"] })
    for (const result of results) {
      expect(result.queryMatch).toBe(0)
      expect(result.score).toBe(result.ppr)
    }
  })
})

describe("rankRelated: a signal at weight 0 has no effect", () => {
  const nodes = [
    node("s"),
    node("d1", "Decision", { status: "superseded", degree: 50 }),
    node("d2", "Decision", { status: "accepted", degree: 2 }),
    node("p1", "PullRequest", {
      degree: 9,
      eventDate: "2024-01-01T00:00:00.000Z",
    }),
    node("p2", "PullRequest", {
      degree: 1,
      reviewDecision: "APPROVED",
      eventDate: "2026-09-01T00:00:00.000Z",
    }),
  ]
  const signals = [
    signal("s", "d1", 0.3),
    signal("s", "d2", 0.9),
    signal("s", "p1", 0.5),
    signal("s", "p2", 0.7),
  ]
  const neutral = {
    nodes: nodes.map((item) => ({
      id: item.id,
      kind: "note",
      degree: null,
    })),
    signals: signals.map((item) => ({ ...item, confidence: 0.5 })),
  }
  const off = {
    signalWeights: { truth: 0, authority: 0, recency: 0 },
    hubPenalty: 0,
  }

  it("gives the same ranking as a graph without the signal", () => {
    const strip = (results: ReturnType<typeof rankRelated>) =>
      results.map((result) => [result.id, result.ppr])
    const actual = strip(
      rank({ nodes, signals, seeds: ["s"], options: { ...off } }),
    )
    const expected = strip(rank({ ...neutral, seeds: ["s"], options: off }))
    expect(actual.map(([id]) => id)).toEqual(expected.map(([id]) => id))
    for (const [index, [, ppr]] of actual.entries()) {
      expect(ppr).toBeCloseTo(Number(expected[index]?.[1]), 12)
    }
  })

  it.each([
    "truth",
    "authority",
    "recency",
    "hubPenalty",
  ] as const)("turns off %s alone", (name) => {
    const base: RelevanceOptions = {
      intent: "change",
      signalWeights: { truth: 1, authority: 1, recency: 1 },
      hubPenalty: 0.5,
    }
    const zero: RelevanceOptions =
      name === "hubPenalty"
        ? { ...base, hubPenalty: 0 }
        : {
            ...base,
            signalWeights: { ...base.signalWeights, [name]: 0 },
          }
    // Make the graph neutral in this one signal only.
    const flat = {
      nodes: nodes.map((item) => {
        if (name === "authority")
          return { ...item, status: null, reviewDecision: null }
        if (name === "recency") return { ...item, eventDate: null }
        if (name === "hubPenalty") return { ...item, degree: null }
        return item
      }),
      signals: signals.map((item) =>
        name === "truth" ? { ...item, confidence: 0.5 } : item,
      ),
    }
    const ppr = (results: ReturnType<typeof rankRelated>) =>
      results.map((result) => [result.id, result.ppr])
    expect(ppr(rank({ nodes, signals, seeds: ["s"], options: zero }))).toEqual(
      ppr(rank({ ...flat, seeds: ["s"], options: zero })),
    )
    // The signal has an effect at a weight above 0.
    expect(
      ppr(rank({ nodes, signals, seeds: ["s"], options: base })),
    ).not.toEqual(ppr(rank({ ...flat, seeds: ["s"], options: base })))
  })

  it("turns off the query with queryWeight 0", () => {
    const plain = rank({ nodes, signals, seeds: ["s"] })
    const query = rank({
      nodes,
      signals,
      seeds: ["s"],
      queryHits: [{ id: "d1", score: 0.03 }],
      options: { queryWeight: 0 },
    })
    expect(query).toEqual(plain)
  })
})

describe("rankRelated path explanation", () => {
  it("explains a result with the path of the highest weight product", () => {
    const [target] = rank({
      nodes: [node("s"), node("a"), node("b"), node("t")],
      signals: [
        signal("s", "t", 0.6),
        signal("s", "a", 0.9),
        signal("a", "t", 0.9),
        signal("s", "b", 0.5),
        signal("b", "t", 1),
      ],
      seeds: ["s"],
      options: { direction: "out" },
    }).filter((result) => result.id === "t")
    expect(
      target?.path.map((step) => [step.from, step.to, step.predicate]),
    ).toEqual([
      ["s", "a", "LINKS_TO"],
      ["a", "t", "LINKS_TO"],
    ])
    expect(target?.path[0]?.weight).toBeCloseTo(0.9, 9)
  })

  it("keeps the stored edge direction on a reverse step", () => {
    const [result] = rank({
      nodes: [node("s"), node("owner")],
      signals: [signal("owner", "s", 0.8, { predicate: "OWNS" })],
      seeds: ["s"],
    })
    expect(result?.path).toEqual([
      { from: "owner", to: "s", predicate: "OWNS", weight: 0.8 },
    ])
  })
})

describe("rankRelated diversity", () => {
  // A seed links to a hub with twelve leaves of one kind, and weakly to five
  // nodes of other kinds.
  const leaves = Array.from({ length: 12 }, (_, index) => `leaf${index}`)
  const others = ["decision", "runbook", "ticket", "incident", "service"]
  const input = {
    nodes: [
      node("s"),
      node("hub", "team"),
      ...leaves.map((id) => node(id, "repository")),
      ...others.map((kind) => node(`other-${kind}`, kind)),
    ],
    signals: [
      signal("s", "hub", 1),
      ...leaves.map((id) => signal("hub", id, 0.9)),
      ...others.map((kind) => signal("s", `other-${kind}`, 0.05)),
    ],
    seeds: ["s"],
  }
  const leafCount = (results: ReturnType<typeof rankRelated>) =>
    results.slice(0, 10).filter((result) => result.id.startsWith("leaf")).length

  it("lets the hub fill the top 10 without diversity", () => {
    expect(leafCount(rank({ ...input, options: { diversity: 0 } }))).toBe(9)
  })

  it("does not let the hub fill the top 10 with diversity 0.3", () => {
    const results = rank({ ...input, options: { diversity: 0.3 } })
    expect(leafCount(results)).toBeLessThanOrEqual(4)
    for (const kind of others) {
      expect(results.slice(0, 10).map((result) => result.id)).toContain(
        `other-${kind}`,
      )
    }
  })

  it("spreads the kinds when no neighbors are shared", () => {
    const repositories = Array.from({ length: 6 }, (_, index) => `repo${index}`)
    const kinds = ["incident", "runbook", "ticket"]
    const flat = {
      nodes: [
        node("s"),
        ...repositories.map((id) => node(id, "repository")),
        ...kinds.map((kind) => node(kind, kind)),
      ],
      signals: [
        ...repositories.map((id) => signal("s", id, 0.9)),
        ...kinds.map((kind) => signal("s", kind, 0.75)),
      ],
      seeds: ["s"],
    }
    const topFour = (diversity: number) =>
      rank({ ...flat, options: { diversity } })
        .slice(0, 4)
        .map((result) => result.id)
    expect(topFour(0)).toEqual(["repo0", "repo1", "repo2", "repo3"])
    const diverse = topFour(0.3)
    expect(diverse[0]).toBe("repo0")
    expect(diverse.slice(1).sort()).toEqual(kinds)
  })

  it("caps the results of one kind with maxPerKind", () => {
    const results = rank({ ...input, options: { maxPerKind: 2 } })
    expect(
      results.filter((result) => result.kind === "repository"),
    ).toHaveLength(2)
  })

  it("stops at limit", () => {
    expect(rank({ ...input, options: { limit: 3 } })).toHaveLength(3)
  })
})
