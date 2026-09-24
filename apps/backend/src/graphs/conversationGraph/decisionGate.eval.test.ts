import { describe, expect, it } from "vitest"
import type { Candidate } from "../../retrieval/schema/candidate.js"
import { decisionGate } from "./decisionGate.js"
import {
  type DecisionGateCase,
  decisionGateCasesExist,
  readDecisionGateCases,
  readProductionDecisions,
} from "./decisionGateCases.js"

/**
 * Scores the gate against real Decision objects from production
 * (evals/decision-gate/decisions.json). Every decision is a candidate, so the
 * gate — not retrieval — must find the covering one or none.
 */

const decisions = readProductionDecisions()

function candidatesFor(c: DecisionGateCase): Candidate[] {
  const kept = decisions
    .filter((d) => !c.exclude?.includes(d.path ?? ""))
    .map((d) => ({ kind: "Decision", ...d }))
  return [...kept, ...(c.inject ?? [])].map((payload, i) => ({
    id: `${c.id}-${i}`,
    sourceChannels: ["semantic" as const],
    payload,
  }))
}

function score(cases: DecisionGateCase[]) {
  const failures: string[] = []
  const tally = { tp: 0, fp: 0, fn: 0, tn: 0, wrongCoverage: 0 }
  for (const c of cases) {
    const gate = decisionGate(c.prompt, candidatesFor(c))
    const injectedCover = (c.inject ?? [])
      .filter((i) => i.status === "accepted" || i.source_tier === 1)
      .map((i) => i.name)
    const expectedNames = [
      ...(c.covering ?? []).map(
        (path) => decisions.find((d) => d.path === path)?.name,
      ),
      ...(c.covering ? injectedCover : []),
    ]
    if (c.escalate && gate.needsHuman) tally.tp++
    else if (!c.escalate && !gate.needsHuman) tally.tn++
    else if (gate.needsHuman) tally.fp++
    else tally.fn++
    const coverageOk =
      c.escalate ||
      gate.needsHuman ||
      c.covering === null ||
      expectedNames.includes(gate.coveredBy ?? undefined)
    if (!coverageOk) tally.wrongCoverage++
    if (c.escalate !== gate.needsHuman || !coverageOk) {
      failures.push(
        `${c.id}: expected ${c.escalate ? "escalate" : "no escalation"}${c.covering ? ` (covered by ${expectedNames.join(" | ")})` : ""}; got ${gate.needsHuman ? `escalate (${gate.reason})` : `no escalation${gate.coveredBy ? ` (covered by ${gate.coveredBy})` : ""}`}`,
      )
    }
  }
  return { ...tally, total: cases.length, failures }
}

function report(label: string, result: ReturnType<typeof score>): void {
  const precision = result.tp / Math.max(result.tp + result.fp, 1)
  const recall = result.tp / Math.max(result.tp + result.fn, 1)
  process.stdout.write(
    `\n[decision gate eval] ${label}: ${result.total - result.failures.length}/${result.total} correct; escalation precision ${precision.toFixed(2)}, recall ${recall.toFixed(2)}; wrong coverage ${result.wrongCoverage}\n${result.failures.map((f) => `  - ${f}`).join("\n")}\n`,
  )
}

describe("decision gate eval (real production decisions)", () => {
  it("passes every tuning case", () => {
    const result = score(readDecisionGateCases("scenarios.json"))
    report("tuning set", result)
    expect(result.failures).toEqual([])
  })

  // Held-out sets are diagnostic (ADR-038); the floor only stops regressions.
  for (const [file, floor] of [
    ["held-out.json", 25],
    ["held-out-2.json", 20],
  ] as const) {
    it.runIf(decisionGateCasesExist(file))(
      `does not regress on ${file}`,
      () => {
        const result = score(readDecisionGateCases(file))
        report(file, result)
        expect(result.total - result.failures.length).toBeGreaterThanOrEqual(
          floor,
        )
      },
    )
  }
})
