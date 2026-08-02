import { describe, expect, it } from "vitest"
import {
  buildIndexingChecklist,
  getBadgeWord,
  resolveIndexingStep,
} from "./indexingSteps.js"

describe("buildIndexingChecklist", () => {
  it("returns the base checklist when no SCIP languages are supplied", () => {
    const checklist = buildIndexingChecklist()
    expect(checklist.every((k) => !k.startsWith("scip:"))).toBe(true)
    expect(checklist[0]).toBe("queued")
    expect(checklist[checklist.length - 1]).toBe("finalizing")
  })

  it("inserts scip:<lang> keys after detecting_languages", () => {
    const checklist = buildIndexingChecklist(["go", "typescript"])
    const detectIdx = checklist.indexOf("detecting_languages")
    expect(detectIdx).toBeGreaterThan(-1)
    expect(checklist[detectIdx + 1]).toBe("scip:go")
    expect(checklist[detectIdx + 2]).toBe("scip:typescript")
    expect(checklist[detectIdx + 3]).toBe("merging_intelligence")
  })

  it("total with 0 languages is base step count", () => {
    const base = buildIndexingChecklist()
    const withLangs = buildIndexingChecklist(["go", "java", "python"])
    expect(withLangs.length).toBe(base.length + 3)
  })

  it("each language adds exactly one step to the total", () => {
    const base = buildIndexingChecklist().length
    for (const n of [1, 2, 5]) {
      const langs = Array.from({ length: n }, (_, i) => `lang${i}`)
      expect(buildIndexingChecklist(langs).length).toBe(base + n)
    }
  })
})

describe("getBadgeWord", () => {
  it("maps each base key to the plan badge word", () => {
    expect(getBadgeWord("queued")).toBe("queued")
    expect(getBadgeWord("resolving_ref")).toBe("resolving")
    expect(getBadgeWord("index_queue")).toBe("waiting")
    expect(getBadgeWord("cloning")).toBe("cloning")
    expect(getBadgeWord("checking_out")).toBe("checking out")
    expect(getBadgeWord("indexing_search")).toBe("indexing")
    expect(getBadgeWord("detecting_languages")).toBe("indexing")
    expect(getBadgeWord("merging_intelligence")).toBe("indexing")
    expect(getBadgeWord("retracting")).toBe("updating")
    expect(getBadgeWord("finding_roots")).toBe("finding packages")
    expect(getBadgeWord("classifying_packages")).toBe("classifying")
    expect(getBadgeWord("identify_apis")).toBe("analyzing")
    expect(getBadgeWord("extract_instruction_units")).toBe("analyzing")
    expect(getBadgeWord("deduplicating")).toBe("deduplicating")
    expect(getBadgeWord("projecting")).toBe("projecting")
    expect(getBadgeWord("embedding")).toBe("embedding")
    expect(getBadgeWord("syncing_graph")).toBe("syncing")
    expect(getBadgeWord("finalizing")).toBe("finalizing")
  })

  it("returns 'indexing' for any scip:<lang> key (no language in badge)", () => {
    expect(getBadgeWord("scip:go")).toBe("indexing")
    expect(getBadgeWord("scip:typescript")).toBe("indexing")
  })
})

describe("resolveIndexingStep", () => {
  it("returns null for an unknown key", () => {
    expect(resolveIndexingStep("unknown_key" as never)).toBeNull()
  })

  it("resolves queued as step 1 with badge queued", () => {
    const res = resolveIndexingStep("queued")
    expect(res).not.toBeNull()
    expect(res!.step).toBe(1)
    expect(res!.key).toBe("queued")
    expect(res!.badgeWord).toBe("queued")
  })

  it("resolves finalizing as the last step when no SCIP languages", () => {
    const checklist = buildIndexingChecklist()
    const res = resolveIndexingStep("finalizing")
    expect(res).not.toBeNull()
    expect(res!.step).toBe(checklist.length)
    expect(res!.total).toBe(checklist.length)
  })

  it("resolves scip:go correctly when go is in the language list", () => {
    const langs = ["go", "typescript"]
    const checklist = buildIndexingChecklist(langs)
    const res = resolveIndexingStep("scip:go", langs)
    expect(res).not.toBeNull()
    expect(res!.badgeWord).toBe("indexing")
    expect(res!.total).toBe(checklist.length)
    expect(res!.step).toBe(checklist.indexOf("scip:go") + 1)
  })

  it("returns null for scip:go when go is NOT in the language list", () => {
    expect(resolveIndexingStep("scip:go", [])).toBeNull()
    expect(resolveIndexingStep("scip:go", ["typescript"])).toBeNull()
  })
})
