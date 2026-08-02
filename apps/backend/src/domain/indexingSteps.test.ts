import { describe, expect, it } from "vitest"
import {
  buildIndexingChecklist,
  getBadgeWord,
  resolveIndexingStep,
} from "./indexingSteps.js"

describe("buildIndexingChecklist", () => {
  it("returns the base checklist when no SCIP languages are supplied", () => {
    const checklist = buildIndexingChecklist()
    expect(checklist).not.toContain(undefined)
    // Base list does not include any scip: entries
    expect(checklist.every((k) => !k.startsWith("scip:"))).toBe(true)
    // Starts with queued, ends with finalizing
    expect(checklist[0]).toBe("queued")
    expect(checklist[checklist.length - 1]).toBe("finalizing")
  })

  it("inserts scip:<lang> keys after detecting_languages", () => {
    const checklist = buildIndexingChecklist(["go", "typescript"])
    const detectIdx = checklist.indexOf("detecting_languages")
    expect(detectIdx).toBeGreaterThan(-1)
    expect(checklist[detectIdx + 1]).toBe("scip:go")
    expect(checklist[detectIdx + 2]).toBe("scip:typescript")
    // Keys after SCIP should continue with merging_intelligence
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

  it("does not deduplicate repeated language entries", () => {
    const checklist = buildIndexingChecklist(["go", "go"])
    const goCount = checklist.filter((k) => k === "scip:go").length
    expect(goCount).toBe(2)
  })
})

describe("getBadgeWord", () => {
  it("returns 'indexing' for search-related step keys", () => {
    expect(getBadgeWord("indexing_search")).toBe("indexing")
    expect(getBadgeWord("detecting_languages")).toBe("indexing")
    expect(getBadgeWord("merging_intelligence")).toBe("indexing")
    expect(getBadgeWord("retracting")).toBe("indexing")
  })

  it("returns 'indexing' for any scip:<lang> key", () => {
    expect(getBadgeWord("scip:go")).toBe("indexing")
    expect(getBadgeWord("scip:typescript")).toBe("indexing")
    expect(getBadgeWord("scip:python")).toBe("indexing")
    expect(getBadgeWord("scip:java")).toBe("indexing")
  })

  it("returns 'analyzing' for identify_* and related analysis keys", () => {
    expect(getBadgeWord("identify_api_clients")).toBe("analyzing")
    expect(getBadgeWord("identify_apis")).toBe("analyzing")
    expect(getBadgeWord("identify_databases")).toBe("analyzing")
    expect(getBadgeWord("identify_infrastructure")).toBe("analyzing")
    expect(getBadgeWord("identify_streams")).toBe("analyzing")
    expect(getBadgeWord("identify_service_dependencies")).toBe("analyzing")
    expect(getBadgeWord("identify_libraries")).toBe("analyzing")
    expect(getBadgeWord("identify_patterns")).toBe("analyzing")
    expect(getBadgeWord("finding_roots")).toBe("analyzing")
    expect(getBadgeWord("classifying_packages")).toBe("analyzing")
    expect(getBadgeWord("extract_instruction_units")).toBe("analyzing")
  })

  it("returns 'ingesting' for queuing, cloning, embedding, syncing, and finalization keys", () => {
    expect(getBadgeWord("queued")).toBe("ingesting")
    expect(getBadgeWord("resolving_ref")).toBe("ingesting")
    expect(getBadgeWord("index_queue")).toBe("ingesting")
    expect(getBadgeWord("cloning")).toBe("ingesting")
    expect(getBadgeWord("checking_out")).toBe("ingesting")
    expect(getBadgeWord("deduplicating")).toBe("ingesting")
    expect(getBadgeWord("projecting")).toBe("ingesting")
    expect(getBadgeWord("embedding")).toBe("ingesting")
    expect(getBadgeWord("syncing_graph")).toBe("ingesting")
    expect(getBadgeWord("finalizing")).toBe("ingesting")
  })
})

describe("resolveIndexingStep", () => {
  it("returns null for an unknown key", () => {
    expect(resolveIndexingStep("unknown_key" as never)).toBeNull()
  })

  it("resolves queued as step 1", () => {
    const res = resolveIndexingStep("queued")
    expect(res).not.toBeNull()
    expect(res!.step).toBe(1)
    expect(res!.key).toBe("queued")
    expect(res!.badgeWord).toBe("ingesting")
  })

  it("resolves finalizing as the last step when no SCIP languages", () => {
    const checklist = buildIndexingChecklist()
    const res = resolveIndexingStep("finalizing")
    expect(res).not.toBeNull()
    expect(res!.step).toBe(checklist.length)
    expect(res!.total).toBe(checklist.length)
  })

  it("resolves scip:go correctly when go is in the language list", () => {
    const res = resolveIndexingStep("scip:go", ["go", "typescript"])
    expect(res).not.toBeNull()
    expect(res!.badgeWord).toBe("indexing")
    expect(res!.total).toBe(buildIndexingChecklist(["go", "typescript"]).length)
    // step must be after detecting_languages
    const checklist = buildIndexingChecklist(["go", "typescript"])
    expect(res!.step).toBe(checklist.indexOf("scip:go") + 1)
  })

  it("returns null for scip:go when go is NOT in the language list", () => {
    expect(resolveIndexingStep("scip:go", [])).toBeNull()
    expect(resolveIndexingStep("scip:go", ["typescript"])).toBeNull()
  })

  it("total matches checklist length", () => {
    const langs = ["go", "rust"]
    const checklist = buildIndexingChecklist(langs)
    for (const key of checklist) {
      const res = resolveIndexingStep(key, langs)
      expect(res).not.toBeNull()
      expect(res!.total).toBe(checklist.length)
    }
  })
})
