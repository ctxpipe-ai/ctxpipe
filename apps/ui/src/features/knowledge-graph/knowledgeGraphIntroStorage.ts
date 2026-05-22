/** Per-org, per-browser flag so returning users are not interrupted. */
export function knowledgeGraphIntroStorageKey(orgSlug: string): string {
  return `ctxpipe:kgIntroDismissed:v1:${orgSlug}`
}

export function shouldShowKnowledgeGraphIntro(orgSlug: string): boolean {
  return !isKnowledgeGraphIntroDismissed(orgSlug)
}

export function isKnowledgeGraphIntroDismissed(orgSlug: string): boolean {
  if (typeof window === "undefined") return false
  return window.localStorage.getItem(knowledgeGraphIntroStorageKey(orgSlug)) === "1"
}

export function dismissKnowledgeGraphIntro(orgSlug: string): void {
  if (typeof window === "undefined") return
  window.localStorage.setItem(knowledgeGraphIntroStorageKey(orgSlug), "1")
}
