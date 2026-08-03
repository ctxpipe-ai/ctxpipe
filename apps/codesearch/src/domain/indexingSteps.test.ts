import { describe, expect, it, vi } from "vitest"
import {
  buildIndexingChecklist,
  getBadgeWord,
  resolveHighestCompletedScipStep,
  resolveIndexingStep,
  setRepositoryIndexingStep,
  trySetRepositoryIndexingStep,
} from "./indexingSteps.js"
import type { Db } from "../db/client.js"

describe("buildIndexingChecklist", () => {
  it("returns base steps in order when no SCIP languages given", () => {
    const checklist = buildIndexingChecklist([])
    expect(checklist[0]).toBe("queued")
    expect(checklist).toContain("index_queue")
    expect(checklist).toContain("cloning")
    expect(checklist).toContain("checking_out")
    expect(checklist).toContain("indexing_search")
    expect(checklist).toContain("detecting_languages")
    expect(checklist).toContain("merging_intelligence")
    expect(checklist).toContain("finalizing")
    expect(checklist.filter((k) => k.startsWith("scip:"))).toHaveLength(0)
  })

  it("inserts scip:<lang> keys after detecting_languages", () => {
    const checklist = buildIndexingChecklist(["typescript", "go"])
    const detectIdx = checklist.indexOf("detecting_languages")
    expect(detectIdx).toBeGreaterThan(-1)
    expect(checklist[detectIdx + 1]).toBe("scip:typescript")
    expect(checklist[detectIdx + 2]).toBe("scip:go")
    expect(checklist[detectIdx + 3]).toBe("merging_intelligence")
  })

  it("total grows by the number of scip languages", () => {
    const base = buildIndexingChecklist([]).length
    const withTwo = buildIndexingChecklist(["typescript", "go"]).length
    expect(withTwo).toBe(base + 2)
  })
})

describe("getBadgeWord", () => {
  it("maps base step keys to expected badge words", () => {
    expect(getBadgeWord("cloning")).toBe("cloning")
    expect(getBadgeWord("checking_out")).toBe("checking out")
    expect(getBadgeWord("index_queue")).toBe("indexing")
    expect(getBadgeWord("indexing_search")).toBe("indexing")
    expect(getBadgeWord("detecting_languages")).toBe("indexing")
    expect(getBadgeWord("merging_intelligence")).toBe("indexing")
    expect(getBadgeWord("finalizing")).toBe("finalizing")
  })

  it("maps all scip:<lang> keys to 'indexing'", () => {
    expect(getBadgeWord("scip:typescript")).toBe("indexing")
    expect(getBadgeWord("scip:go")).toBe("indexing")
    expect(getBadgeWord("scip:rust")).toBe("indexing")
  })
})

describe("resolveIndexingStep", () => {
  it("returns null for unknown key", () => {
    expect(resolveIndexingStep("unknown_key" as never)).toBeNull()
  })

  it("resolves cloning to correct 1-based position", () => {
    const result = resolveIndexingStep("cloning")
    expect(result).not.toBeNull()
    expect(result!.key).toBe("cloning")
    expect(result!.step).toBeGreaterThan(0)
    expect(result!.total).toBeGreaterThan(result!.step)
    expect(result!.badgeWord).toBe("cloning")
  })

  it("resolves scip:typescript with correct step/total when languages known", () => {
    const langs = ["typescript", "go"]
    const result = resolveIndexingStep("scip:typescript", langs)
    expect(result).not.toBeNull()
    expect(result!.key).toBe("scip:typescript")
    expect(result!.badgeWord).toBe("indexing")
    // scip:go should be one step after scip:typescript
    const goResult = resolveIndexingStep("scip:go", langs)
    expect(goResult!.step).toBe(result!.step + 1)
    expect(goResult!.total).toBe(result!.total)
  })

  it("total matches buildIndexingChecklist length", () => {
    const langs = ["typescript", "go", "python"]
    const checklist = buildIndexingChecklist(langs)
    const result = resolveIndexingStep("cloning", langs)
    expect(result!.total).toBe(checklist.length)
  })

  it("step is 1-based index matching checklist position", () => {
    const checklist = buildIndexingChecklist([])
    const cloningIdx = checklist.indexOf("cloning")
    const result = resolveIndexingStep("cloning")
    expect(result!.step).toBe(cloningIdx + 1)
  })
})

describe("resolveHighestCompletedScipStep", () => {
  it("returns the highest checklist step among completed SCIP languages", () => {
    const result = resolveHighestCompletedScipStep(
      new Set(["typescript", "go"]),
      ["typescript", "go", "python"],
    )

    expect(result).not.toBeNull()
    expect(result!.key).toBe("scip:go")
    expect(result!.step).toBe(
      resolveIndexingStep("scip:go", ["typescript", "go", "python"])!.step,
    )
  })

  it("ignores completed languages outside the current SCIP checklist", () => {
    const result = resolveHighestCompletedScipStep(
      new Set(["rust"]),
      ["typescript", "go"],
    )

    expect(result).toBeNull()
  })
})

describe("setRepositoryIndexingStep", () => {
  function makeMockDb() {
    const updateSet = vi.fn().mockReturnThis()
    const updateWhere = vi.fn().mockResolvedValue(undefined)
    const update = vi.fn().mockReturnValue({ set: updateSet })
    updateSet.mockReturnValue({ where: updateWhere })
    return {
      db: { update } as unknown as Db,
      update,
      updateSet,
      updateWhere,
    }
  }

  it("calls db.update with resolved step/total/key", async () => {
    const { db, update, updateSet, updateWhere } = makeMockDb()
    await setRepositoryIndexingStep(db, "repo_abc", "cloning", [])
    expect(update).toHaveBeenCalledOnce()
    expect(updateSet).toHaveBeenCalledOnce()
    const setArgs = updateSet.mock.calls[0][0]
    expect(setArgs.indexingStepKey).toBe("cloning")
    expect(typeof setArgs.indexingStep).toBe("number")
    expect(typeof setArgs.indexingStepTotal).toBe("number")
    expect(setArgs.indexingStep).toBeGreaterThan(0)
    expect(updateWhere).toHaveBeenCalledOnce()
  })

  it("does not call db.update for an unknown key", async () => {
    const { db, update } = makeMockDb()
    await setRepositoryIndexingStep(db, "repo_abc", "unknown_key" as never, [])
    expect(update).not.toHaveBeenCalled()
  })

  it("includes scip languages in total when writing a scip step", async () => {
    const { db, updateSet } = makeMockDb()
    const langs = ["typescript", "go"]
    await setRepositoryIndexingStep(db, "repo_abc", "scip:typescript", langs)
    const setArgs = updateSet.mock.calls[0][0]
    expect(setArgs.indexingStepKey).toBe("scip:typescript")
    const baseTotal = resolveIndexingStep("cloning")!.total
    expect(setArgs.indexingStepTotal).toBe(baseTotal + langs.length)
  })
})

describe("trySetRepositoryIndexingStep", () => {
  it("swallows errors from db", async () => {
    const update = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error("DB error")),
      }),
    })
    const db = { update } as unknown as Db
    await expect(
      trySetRepositoryIndexingStep(db, "repo_abc", "cloning"),
    ).resolves.toBeUndefined()
  })
})
