export function workspaceChatRetrievalSnippets(input: {
  query: string
  units: ReadonlyArray<{ path: string; body: string }>
  limit?: number
}): string {
  const terms = input.query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 2)
  const ranked = input.units
    .map((unit) => {
      const haystack = `${unit.path}\n${unit.body}`.toLowerCase()
      const score = terms.reduce(
        (sum, term) => sum + (haystack.includes(term) ? 1 : 0),
        0,
      )
      return { unit, score }
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 6)
  if (ranked.length === 0) return ""
  return [
    "Workspace projection context:",
    ...ranked.map(
      (row) => `## ${row.unit.path}\n${row.unit.body.trim().slice(0, 1200)}`,
    ),
  ].join("\n\n")
}
