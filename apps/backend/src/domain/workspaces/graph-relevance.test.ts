import { describe, expect, it } from "vitest"
import type { GraphExpansion } from "./graph-expand.js"
import {
  INTENT_PRESETS,
  RELEVANCE_INTENTS,
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
    sourceId: from,
    targetId: to,
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
        signals: [signal("a", "b", 1)],
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
        signals: [signal("a", "b", 1), signal("b", "c", 1)],
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

describe("rankRelated recency", () => {
  const changes = [
    signal("s", "new", 0.8, {
      predicate: "CHANGED",
      validFrom: "2026-09-20T00:00:00.000Z",
    }),
    signal("s", "old", 0.8, {
      predicate: "CHANGED",
      validFrom: "2025-09-20T00:00:00.000Z",
    }),
  ]
  const changeNodes = [node("s"), node("new"), node("old")]

  it("ranks a recent change edge first for the change intent", () => {
    expect(
      rank({
        nodes: changeNodes,
        signals: changes,
        seeds: ["s"],
        options: { intent: "change" },
      }).map((result) => result.id),
    ).toEqual(["new", "old"])
  })

  it("uses recencyHalfLifeDays", () => {
    const results = byId(
      rank({
        nodes: changeNodes,
        signals: changes,
        seeds: ["s"],
        options: {
          intent: "change",
          recencyHalfLifeDays: 36_500,
          signalWeights: { truth: 0 },
        },
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

  it("walks FROM_SOURCE only for the provenance intent, which weights it most", () => {
    for (const intent of RELEVANCE_INTENTS) {
      expect(
        INTENT_PRESETS[intent].walk?.includes("FROM_SOURCE") ?? false,
        intent,
      ).toBe(intent === "provenance")
    }
    const input = {
      nodes: [node("s"), node("source"), node("doc")],
      signals: [
        signal("s", "source", 0.8, { predicate: "FROM_SOURCE" }),
        signal("s", "doc", 0.8),
      ],
      seeds: ["s"],
    }
    const provenance = byId(
      rank({ ...input, options: { intent: "provenance" } }),
    )
    expect(
      (provenance.get("source")?.ppr ?? 0) / (provenance.get("doc")?.ppr ?? 1),
    ).toBeCloseTo(3, 6)
  })

  it("ranks the sources of a seed first and their other units last for provenance", () => {
    const siblings = ["x1", "x2", "x3", "x4"]
    const input = {
      nodes: [
        node("s"),
        node("src", "Source"),
        node("doc"),
        ...siblings.map((id) => node(id)),
      ],
      signals: [
        signal("s", "src", 1, { predicate: "FROM_SOURCE" }),
        ...siblings.map((id) =>
          signal(id, "src", 1, { predicate: "FROM_SOURCE" }),
        ),
        signal("s", "doc", 0.3),
      ],
      seeds: ["s"],
    }
    for (const diversity of [0, 0.3]) {
      const ids = rank({
        ...input,
        options: { intent: "provenance", diversity, limit: 3 },
      }).map((result) => result.id)
      expect(ids[0], `diversity ${diversity}`).toBe("src")
      expect(ids[1], `diversity ${diversity}`).toBe("doc")
    }
    const ofSource = rank({
      ...input,
      seeds: ["src"],
      options: { intent: "provenance", limit: 6 },
    }).map((result) => result.id)
    expect(ofSource.slice(0, 5).sort()).toEqual(["s", ...siblings].sort())
    expect(ofSource[5]).toBe("doc")
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
    node("d1", "Decision", { degree: 50 }),
    node("d2", "Decision", { degree: 2 }),
    node("p1", "PullRequest", { degree: 9 }),
    node("p2", "PullRequest", { degree: 1 }),
  ]
  const signals = [
    signal("s", "d1", 0.3),
    signal("s", "d2", 0.9),
    signal("s", "p1", 0.5, {
      predicate: "CHANGED",
      validFrom: "2024-01-01T00:00:00.000Z",
    }),
    signal("s", "p2", 0.7, {
      predicate: "CHANGED",
      validFrom: "2026-09-01T00:00:00.000Z",
    }),
  ]
  const off = {
    signalWeights: { truth: 0, recency: 0 },
    hubPenalty: 0,
  }

  it("gives the same ranking as a graph without the signal", () => {
    const neutral = {
      nodes: nodes.map((item) => ({ ...item, degree: null })),
      signals: signals.map((item) => ({
        ...item,
        confidence: 0.5,
        validFrom: null,
      })),
    }
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
    "recency",
    "hubPenalty",
  ] as const)("turns off %s alone", (name) => {
    const base: RelevanceOptions = {
      intent: "change",
      signalWeights: { truth: 1, recency: 1 },
      hubPenalty: 0.5,
      predicateWeights: { LINKS_TO: 3 },
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
      nodes: nodes.map((item) =>
        name === "hubPenalty" ? { ...item, degree: null } : item,
      ),
      signals: signals.map((item) => {
        if (name === "truth") return { ...item, confidence: 0.5 }
        // A predicate that is not a change has no recency factor.
        if (name === "recency") return { ...item, predicate: "LINKS_TO" }
        return item
      }),
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

describe("rankRelated input from the graph expansion", () => {
  it("takes the nodes and edges of a GraphExpansion as they are", () => {
    const expansion: Pick<GraphExpansion, "nodes" | "edges"> = {
      nodes: ["s", "t"].map((id, index) => ({
        id,
        kind: "note",
        name: id,
        summary: null,
        path: `${id}.md`,
        degree: 1,
        inDegree: index,
        outDegree: 1 - index,
        depth: index,
      })),
      edges: [
        {
          id: "e1",
          sourceId: "s",
          targetId: "t",
          predicate: "LINKS_TO",
          confidence: 0.8,
          validFrom: "2026-01-01T00:00:00.000Z",
          validTo: null,
          source: "git",
          lastObservedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }
    const [result] = rankRelated({
      nodes: expansion.nodes,
      signals: expansion.edges,
      seeds: ["s"],
      options: { now: NOW },
    })
    expect(result?.id).toBe("t")
    expect(result?.path).toEqual([
      expect.objectContaining({ from: "s", to: "t", predicate: "LINKS_TO" }),
    ])
  })
})

describe("rankRelated option bounds", () => {
  const input = {
    nodes: [node("s"), node("t")],
    signals: [signal("s", "t")],
    seeds: ["s"],
  }

  it.each([
    ["hubPenalty", { hubPenalty: -1 }],
    ["restart", { restart: 0 }],
    ["restart", { restart: 1 }],
    ["restart", { restart: 1.5 }],
    ["recencyHalfLifeDays", { recencyHalfLifeDays: 0 }],
    ["recencyHalfLifeDays", { recencyHalfLifeDays: Number.NaN }],
    ["diversity", { diversity: 1.5 }],
    ["diversity", { diversity: -0.1 }],
    ["queryWeight", { queryWeight: 2 }],
    ["queryWeight", { queryWeight: Number.NaN }],
    ["signalWeights.truth", { signalWeights: { truth: -1 } }],
    ["signalWeights.recency", { signalWeights: { recency: -1 } }],
  ] as const)("throws a RangeError that names %s", (name, options) => {
    expect(() => rank({ ...input, options })).toThrow(RangeError)
    expect(() => rank({ ...input, options })).toThrow(name)
  })

  it("accepts the edges of the ranges", () => {
    expect(() =>
      rank({
        ...input,
        options: { queryWeight: 1, diversity: 1, hubPenalty: 0, restart: 0.01 },
      }),
    ).not.toThrow()
  })

  it("gives a path weight of at most 1 even with a large predicate weight", () => {
    const [result] = rank({
      ...input,
      options: { predicateWeights: { LINKS_TO: 50 } },
    })
    expect(result?.path[0]?.weight).toBeGreaterThan(0)
    expect(result?.path[0]?.weight).toBeLessThanOrEqual(1)
  })
})

describe("rankRelated validBetween", () => {
  const nodes = [node("s"), node("t")]
  const ended = [
    signal("s", "t", 0.8, {
      validFrom: "2025-03-01T00:00:00.000Z",
      validTo: "2025-06-01T00:00:00.000Z",
    }),
  ]

  it("ranks the target of an edge that ended inside the window", () => {
    const results = rank({
      nodes,
      signals: ended,
      seeds: ["s"],
      options: {
        validBetween: {
          from: new Date("2025-01-01T00:00:00.000Z"),
          to: new Date("2025-12-31T00:00:00.000Z"),
        },
      },
    })
    expect(results.map((result) => result.id)).toEqual(["t"])
  })

  it("drops the edge without the window, because it ended before now", () => {
    expect(rank({ nodes, signals: ended, seeds: ["s"] })).toEqual([])
  })

  it("drops an edge that ended before the window", () => {
    const results = rank({
      nodes,
      signals: ended,
      seeds: ["s"],
      options: {
        validBetween: {
          from: new Date("2025-07-01T00:00:00.000Z"),
          to: new Date("2025-12-31T00:00:00.000Z"),
        },
      },
    })
    expect(results).toEqual([])
  })

  it("drops an edge that starts after the window", () => {
    const results = rank({
      nodes,
      signals: ended,
      seeds: ["s"],
      options: {
        validBetween: {
          from: new Date("2024-01-01T00:00:00.000Z"),
          to: new Date("2025-02-01T00:00:00.000Z"),
        },
      },
    })
    expect(results).toEqual([])
  })

  it("throws a RangeError for a window that ends before it starts", () => {
    expect(() =>
      rank({
        nodes,
        signals: ended,
        seeds: ["s"],
        options: {
          validBetween: {
            from: new Date("2025-12-31T00:00:00.000Z"),
            to: new Date("2025-01-01T00:00:00.000Z"),
          },
        },
      }),
    ).toThrow(RangeError)
  })
})

describe("rankRelated kinds", () => {
  const nodes = [
    node("s"),
    ...["a1", "a2", "a3"].map((id) => node(id, "alpha")),
    ...["b1", "b2", "b3", "b4"].map((id) => node(id, "beta")),
  ]
  // The beta units have the stronger edges, so they fill the top of the ranking.
  const signals = [
    ...["a1", "a2", "a3"].map((id) => signal("s", id, 0.3)),
    ...["b1", "b2", "b3", "b4"].map((id) => signal("s", id, 0.9)),
  ]

  it("returns limit results of the kept kinds when enough exist", () => {
    const results = rank({
      nodes,
      signals,
      seeds: ["s"],
      options: { kinds: ["alpha"], limit: 3 },
    })
    expect(results.map((result) => result.id).sort()).toEqual([
      "a1",
      "a2",
      "a3",
    ])
  })

  it("applies maxPerKind and diversity to the kept kinds only", () => {
    const results = rank({
      nodes,
      signals,
      seeds: ["s"],
      options: { kinds: ["alpha", "BETA"], maxPerKind: 2, limit: 10 },
    })
    expect(results).toHaveLength(4)
  })

  it("still walks through a unit of a kind that is left out", () => {
    const results = rank({
      nodes: [node("s"), node("mid", "beta"), node("far", "alpha")],
      signals: [signal("s", "mid"), signal("mid", "far")],
      seeds: ["s"],
      options: { kinds: ["alpha"] },
    })
    expect(results.map((result) => result.id)).toEqual(["far"])
    expect(results[0]?.path.map((step) => step.to)).toEqual(["mid", "far"])
  })
})

describe("rankRelated has no node-level authority", () => {
  it("gives a pull request and a note of the same structure the same score", () => {
    for (const intent of ["general", "change", "why"] as const) {
      const results = byId(
        rank({
          nodes: [
            node("s"),
            node("pr", "PullRequest"),
            node("note", "note"),
            node("thread", "Thread"),
            node("decision", "Decision"),
          ],
          signals: ["pr", "note", "thread", "decision"].map((id) =>
            signal("s", id),
          ),
          seeds: ["s"],
          options: { intent },
        }),
      )
      const scores = new Set(
        ["pr", "note", "thread", "decision"].map(
          (id) => results.get(id)?.score,
        ),
      )
      expect(scores.size).toBe(1)
    }
  })
})

describe("rankRelated absolute weight of a sole step", () => {
  const ppr = (confidence: number) =>
    byId(
      rank({
        nodes: [node("s"), node("t")],
        signals: [signal("s", "t", confidence)],
        seeds: ["s"],
        options: { direction: "out" },
      }),
    ).get("t")?.ppr ?? 0

  it("gives a weak sole edge less mass than a strong one", () => {
    expect(ppr(0.06)).toBeLessThan(ppr(1))
  })

  it("sends the remainder to the restart vector", () => {
    // p_t = 0.85 w p_s; the rest of the mass returns to s.
    const w = 0.5
    const results = byId(
      rank({
        nodes: [node("s"), node("t")],
        signals: [signal("s", "t", w)],
        seeds: ["s"],
        options: { direction: "out", includeSeeds: true },
      }),
    )
    const sum = (results.get("s")?.ppr ?? 0) + (results.get("t")?.ppr ?? 0)
    expect(sum).toBeCloseTo(1, 9)
    expect(results.get("t")?.ppr).toBeCloseTo(
      0.85 * w * (results.get("s")?.ppr ?? 0),
      9,
    )
  })
})

describe("rankRelated path cost", () => {
  const input = {
    nodes: [node("s"), node("x"), node("t")],
    signals: [
      signal("s", "t", 0.3),
      signal("s", "x", 0.6),
      signal("x", "t", 0.6),
    ],
    seeds: ["s"],
  }

  it.each([
    "general",
    "why",
    "change",
  ] as const)("prefers the 2-hop path of weight 0.36 over the 1-hop of 0.3 for %s", (intent) => {
    const t = byId(
      rank({ ...input, options: { intent, direction: "out" } }),
    ).get("t")
    expect(t?.path.map((step) => step.to)).toEqual(["x", "t"])
  })
})

describe("rankRelated determinism", () => {
  const nodes = [
    node("s"),
    ...["a", "b", "c", "d", "e"].map((id) => node(id, id < "c" ? "k1" : "k2")),
  ]
  const signals = [
    signal("s", "a", 0.7),
    signal("s", "b", 0.7),
    signal("a", "c", 0.5),
    signal("b", "c", 0.5),
    signal("c", "d", 0.9),
    signal("c", "d", 0.4, { source: "other" }),
    signal("a", "e", 0.2),
    signal("b", "e", 0.2),
  ]

  it("gives the same results and paths for reversed input order", () => {
    const options = { diversity: 0.3, direction: "both" } as const
    const forward = rankRelated({
      nodes,
      signals,
      seeds: ["s"],
      options: { now: NOW, ...options },
    })
    const reversed = rankRelated({
      nodes: [...nodes].reverse(),
      signals: [...signals].reverse(),
      seeds: ["s"],
      options: { now: NOW, ...options },
    })
    expect(reversed).toEqual(forward)
  })

  it("breaks a tie by id with a plain comparison", () => {
    const results = rank({
      nodes: [node("s"), node("B"), node("a")],
      signals: [signal("s", "B"), signal("s", "a")],
      seeds: ["s"],
    })
    // Code-unit order: "B" < "a". localeCompare would put "a" first.
    expect(results.map((result) => result.id)).toEqual(["B", "a"])
  })
})

describe("rankRelated restart share of the query", () => {
  it("gives the query hits exactly queryWeight of the restart mass", () => {
    const results = byId(
      rank({
        nodes: [node("s"), node("q")],
        signals: [],
        seeds: ["s"],
        queryHits: [{ id: "q", score: 0.03 }],
        options: { queryWeight: 0.5, includeSeeds: true },
      }),
    )
    expect(results.get("s")?.ppr).toBeCloseTo(0.5, 9)
    expect(results.get("q")?.ppr).toBeCloseTo(0.5, 9)
  })
})
