import { describe, expect, it } from "vitest"
import {
  authority,
  classifyIntent,
  combineSignals,
  type EdgeCandidate,
  edgeTruth,
  INTENT_PROFILES,
  normalizeSearchHits,
  type RetrievalSignals,
  recency,
  retrievalProfile,
  SIGNAL_FLOOR,
  type SignalWeights,
  scoreEdge,
  searchRelevance,
  specificity,
  turnGroup,
} from "./retrievalScore.js"

const asOf = new Date("2026-10-05T00:00:00.000Z")
const daysAgo = (days: number) =>
  new Date(asOf.getTime() - days * 86_400_000).toISOString()

describe("truth", () => {
  it("combines agreeing evidence with noisy-OR, so agreement raises it", () => {
    expect(edgeTruth(0.6, 1)).toBeCloseTo(0.6)
    expect(edgeTruth(0.6, 2)).toBeCloseTo(0.84)
    expect(edgeTruth(0.6, 3)).toBeCloseTo(0.936)
  })

  it("counts at most three sources, because sources in one repository are not fully independent", () => {
    expect(edgeTruth(0.6, 10)).toBeCloseTo(edgeTruth(0.6, 3))
  })

  it("keeps one strong source above three weak ones", () => {
    expect(edgeTruth(0.95, 1)).toBeGreaterThan(edgeTruth(0.6, 3))
  })

  it("reads a missing confidence as 0.5 and a missing or zero evidence count as one source", () => {
    expect(edgeTruth(null, null)).toBe(0.5)
    expect(edgeTruth(0.72, 0)).toBeCloseTo(0.72)
  })
})

describe("authority", () => {
  it("follows the ADR lifecycle for decisions", () => {
    expect(authority("Decision", "accepted", null)).toBe(1)
    expect(authority("Decision", null, null)).toBe(0.9)
    expect(authority("Decision", "proposed", null)).toBe(0.6)
    expect(authority("Decision", "superseded", null)).toBe(0.3)
  })

  it("ranks an approved pull request above an unreviewed one, and that above one with changes requested", () => {
    const approved = authority("PullRequest", null, "APPROVED")
    const unreviewed = authority("PullRequest", null, null)
    const changesRequested = authority("PullRequest", null, "CHANGES_REQUESTED")
    expect(approved).toBeGreaterThan(unreviewed)
    expect(unreviewed).toBeGreaterThan(changesRequested)
  })

  it("is 1 for other kinds, whatever their status", () => {
    expect(authority("Issue", "superseded", "CHANGES_REQUESTED")).toBe(1)
  })
})

describe("search", () => {
  it("divides each hit's score by the top score; a hit without a score counts as the top", () => {
    const hits = normalizeSearchHits([
      { id: "a", score: 0.032 },
      { id: "b", score: 0.016 },
      { id: "c" },
    ])
    expect(hits.get("a")).toBeCloseTo(1)
    expect(hits.get("b")).toBeCloseTo(0.5)
    expect(hits.get("c")).toBe(1)
  })

  it("gives a miss 0.5 and the top hit 1", () => {
    expect(searchRelevance(undefined)).toBe(0.5)
    expect(searchRelevance(1)).toBe(1)
    expect(searchRelevance(0.5)).toBeCloseTo(0.75)
  })
})

describe("recency", () => {
  const change = (validFrom: string | null) => ({
    predicate: "MODIFIED",
    validFrom,
    toKind: "File",
    toDate: null,
  })

  it("halves a change every 90 days from its merge date", () => {
    expect(recency(change(daysAgo(0)), asOf)).toBeCloseTo(1)
    expect(recency(change(daysAgo(90)), asOf)).toBeCloseTo(0.5)
    expect(recency(change(daysAgo(180)), asOf)).toBeCloseTo(0.25)
  })

  it("dates a pull request or a thread reached through another edge by the node", () => {
    expect(
      recency(
        {
          predicate: "REFERENCES",
          validFrom: null,
          toKind: "PullRequest",
          toDate: daysAgo(90),
        },
        asOf,
      ),
    ).toBeCloseTo(0.5)
    expect(
      recency(
        {
          predicate: "REFERENCES",
          validFrom: null,
          toKind: "Thread",
          toDate: daysAgo(180),
        },
        asOf,
      ),
    ).toBeCloseTo(0.25)
  })

  it("does not decay decisions, instructions or ownership", () => {
    for (const [predicate, toKind] of [
      ["INFLUENCES", "Decision"],
      ["HAS_INSTRUCTION", "InstructionUnit"],
      ["OWNS", "Team"],
    ] as const) {
      expect(
        recency(
          { predicate, validFrom: daysAgo(900), toKind, toDate: null },
          asOf,
        ),
      ).toBe(1)
    }
  })

  it("counts an undated change as one half-life old", () => {
    expect(recency(change(null), asOf)).toBe(0.5)
  })
})

describe("specificity", () => {
  it("penalizes hubs on a log scale", () => {
    expect(specificity(0)).toBe(1)
    expect(specificity(50)).toBeCloseTo(0.77, 2)
    expect(specificity(6000)).toBeCloseTo(0.32, 2)
    expect(specificity(null)).toBe(1)
  })
})

describe("combineSignals", () => {
  const all = (value: number): RetrievalSignals => ({
    truth: value,
    authority: value,
    search: value,
    recency: value,
    specificity: value,
  })
  const ones: SignalWeights = {
    truth: 1,
    authority: 1,
    search: 1,
    recency: 1,
    specificity: 1,
  }

  it("is the weighted product of the signals", () => {
    const signals = { ...all(1), truth: 0.8, recency: 0.25 }
    expect(combineSignals(signals, { ...ones, recency: 0.5 })).toBeCloseTo(
      0.8 * 0.5,
    )
  })

  it("floors each signal, so a zero signal lowers a fact but does not remove it", () => {
    const score = combineSignals({ ...all(1), recency: 0 }, ones)
    expect(score).toBeCloseTo(SIGNAL_FLOOR)
    expect(score).toBeGreaterThan(0)
  })

  it("ignores a signal with weight 0", () => {
    expect(
      combineSignals({ ...all(1), authority: 0.3 }, { ...ones, authority: 0 }),
    ).toBe(1)
  })
})

describe("intent", () => {
  it.each([
    ["Who owns billing?", "ownership"],
    ["Which team maintains the ledger library?", "ownership"],
    ["Why does billing use a queue?", "why"],
    ["What did we decide about retries? Is there an ADR?", "why"],
    ["What changed recently in billing?", "change"],
    ["Is there prior work on rate limiting?", "change"],
    ["Which pull requests touched the ledger?", "change"],
    ["Who changed the billing API?", "change"],
    ["What does billing depend on?", "structure"],
    ["Which services call the payments API?", "structure"],
    ["Who uses the ledger library?", "structure"],
    ["Tell me about billing", "general"],
  ])("classifies %j as %s", (query, intent) => {
    expect(classifyIntent(query)).toBe(intent)
  })

  it("is general when there is no question", () => {
    expect(classifyIntent(undefined)).toBe("general")
    expect(classifyIntent("")).toBe("general")
  })

  it("lets an explicit intent and single weights replace those of the question", () => {
    const profile = retrievalProfile({
      query: "Who owns billing?",
      weights: { truth: 0 },
    })
    expect(profile.intent).toBe("ownership")
    expect(profile.turns).toEqual({ OWNS: 3 })
    expect(profile.weights).toEqual({
      ...INTENT_PROFILES.ownership.weights,
      truth: 0,
    })

    expect(
      retrievalProfile({ query: "Who owns billing?", intent: "general" }),
    ).toMatchObject({ intent: "general", turns: {} })
  })

  it("gives the why walk more turns for decisions than for their files and changes", () => {
    const { turns } = INTENT_PROFILES.why
    expect(turns.INFLUENCES).toBeGreaterThan(turns.DECLARED_IN ?? 1)
    expect(turns.SUPERSEDES).toBeGreaterThan(turns.CHANGED ?? 1)
  })

  it("groups the change types under one turn", () => {
    for (const predicate of [
      "CHANGED",
      "ADDED",
      "MODIFIED",
      "REMOVED",
      "RENAMED",
    ]) {
      expect(turnGroup(predicate)).toBe("CHANGED")
    }
    expect(turnGroup("TARGETS")).toBe("TARGETS")
  })
})

describe("scoreEdge", () => {
  const candidate = (more: Partial<EdgeCandidate> = {}): EdgeCandidate => ({
    predicate: "DEPENDS_ON",
    parentTruth: 1,
    confidence: 0.8,
    sourceCount: 1,
    validFrom: null,
    toKind: "Library",
    toStatus: null,
    toReviewDecision: null,
    toDate: null,
    degree: null,
    searchScore: undefined,
    ...more,
  })
  const weights = INTENT_PROFILES.general.weights

  it("passes the path truth on, without the other signals", () => {
    const scored = scoreEdge(
      candidate({ parentTruth: 0.9, degree: 6000 }),
      weights,
      asOf,
    )
    expect(scored.truth).toBeCloseTo(0.72)
    expect(scored.score).toBeLessThan(scored.truth)
  })

  it("ranks a corroborated fact above a single-source fact at the same confidence", () => {
    const one = scoreEdge(candidate(), weights, asOf)
    const two = scoreEdge(candidate({ sourceCount: 2 }), weights, asOf)
    expect(two.score).toBeGreaterThan(one.score)
  })

  it("ranks a search hit above a miss with somewhat higher confidence", () => {
    const hit = scoreEdge(
      candidate({ confidence: 0.72, searchScore: 1 }),
      weights,
      asOf,
    )
    const miss = scoreEdge(candidate({ confidence: 0.95 }), weights, asOf)
    expect(hit.score).toBeGreaterThan(miss.score)
  })
})
