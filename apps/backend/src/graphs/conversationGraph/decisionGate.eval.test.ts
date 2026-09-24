import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { Candidate } from "../../retrieval/schema/candidate.js"
import { decisionGate } from "./decisionGate.js"

/**
 * Scores the gate against real Decision objects from production
 * (evals/decision-gate/decisions.json). Every decision is a candidate, so the
 * gate — not retrieval — must find the covering one or none.
 */

type Row = { path?: string; name: string; summary?: string; status?: string }
type Case = {
  id: string
  prompt: string
  escalate: boolean
  covering: string[] | null
  exclude?: string[]
  inject?: Array<Row & { kind: string; corrects?: string }>
}

const evalDir = fileURLToPath(
  new URL("../../../evals/decision-gate/", import.meta.url),
)
const read = <T>(file: string): T =>
  JSON.parse(readFileSync(`${evalDir}${file}`, "utf8")) as T

const decisions = read<{ decisions: Row[] }>("decisions.json").decisions

function candidatesFor(c: Case): Candidate[] {
  const kept = decisions
    .filter((d) => !c.exclude?.includes(d.path ?? ""))
    .map((d) => ({ kind: "Decision", ...d }))
  return [...kept, ...(c.inject ?? [])].map((payload, i) => ({
    id: `${c.id}-${i}`,
    sourceChannels: ["semantic" as const],
    payload,
  }))
}

function score(cases: Case[]) {
  const failures: string[] = []
  const tally = { tp: 0, fp: 0, fn: 0, tn: 0, wrongCoverage: 0 }
  for (const c of cases) {
    const gate = decisionGate(c.prompt, candidatesFor(c))
    const injectedCover = (c.inject ?? [])
      .filter((i) => i.kind === "Decision" && i.status === "accepted")
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
    const result = score(read<{ cases: Case[] }>("scenarios.json").cases)
    report("tuning set", result)
    expect(result.failures).toEqual([])
  })

  for (const file of ["held-out.json", "held-out-2.json"]) {
    it.runIf(existsSync(`${evalDir}${file}`))(`reports ${file}`, () => {
      const result = score(read<{ cases: Case[] }>(file).cases)
      report(file, result)
      expect(result.total).toBeGreaterThan(0)
    })
  }
})
