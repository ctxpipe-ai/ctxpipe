import { afterEach, describe, expect, it, vi } from "vitest"
import {
  dismissKnowledgeGraphIntro,
  isKnowledgeGraphIntroDismissed,
  knowledgeGraphIntroStorageKey,
  shouldShowKnowledgeGraphIntro,
} from "./knowledgeGraphIntroStorage"

function createStorage() {
  const store = new Map<string, string>()

  return {
    getItem(key: string) {
      return store.get(key) ?? null
    },
    setItem(key: string, value: string) {
      store.set(key, value)
    },
  }
}

describe("knowledgeGraphIntroStorage", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("namespaces the dismissal key per org", () => {
    expect(knowledgeGraphIntroStorageKey("acme")).toBe(
      "ctxpipe:kgIntroDismissed:v1:acme",
    )
    expect(knowledgeGraphIntroStorageKey("globex")).toBe(
      "ctxpipe:kgIntroDismissed:v1:globex",
    )
  })

  it("treats the intro as visible until that org is dismissed", () => {
    const localStorage = createStorage()
    vi.stubGlobal("window", {
      localStorage,
    })

    expect(shouldShowKnowledgeGraphIntro("acme")).toBe(true)
    expect(isKnowledgeGraphIntroDismissed("acme")).toBe(false)

    dismissKnowledgeGraphIntro("acme")

    expect(isKnowledgeGraphIntroDismissed("acme")).toBe(true)
    expect(shouldShowKnowledgeGraphIntro("acme")).toBe(false)
    expect(shouldShowKnowledgeGraphIntro("globex")).toBe(true)
  })

  it("is safe when window is unavailable", () => {
    expect(isKnowledgeGraphIntroDismissed("acme")).toBe(false)
    expect(shouldShowKnowledgeGraphIntro("acme")).toBe(true)
    expect(() => dismissKnowledgeGraphIntro("acme")).not.toThrow()
  })
})
