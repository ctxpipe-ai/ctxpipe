import type { SourceAdapter } from "../domain/workspace-sources/adapter.js"
import type { GitFileChange } from "../services/git/file-change.js"

/**
 * A provider adapter for tests. The scope is `{ spaces: string[] }`; each
 * space owns `confluence/<space>/`; the space "*" owns all of `confluence/`. `content` maps a space to its pages.
 * `fetches` records each fetch call, so a test can prove "fetch once".
 */
export function fakeSourceAdapter(
  content: Record<string, Record<string, string>>,
) {
  const fetches: Array<ReadonlyArray<Record<string, unknown>>> = []
  const spacesOf = (scope: Record<string, unknown>) =>
    Array.isArray(scope.spaces) ? (scope.spaces as string[]) : []
  const adapter: SourceAdapter = {
    provider: "confluence",
    managedPaths: (scope) =>
      spacesOf(scope).map((space) =>
        space === "*" ? "confluence/" : `confluence/${space}/`,
      ),
    async fetch({ scopes }) {
      fetches.push(scopes)
      const spaces = new Set(scopes.flatMap(spacesOf))
      return [...spaces].flatMap((space): GitFileChange[] =>
        Object.entries(content[space] ?? {}).map(([page, body]) => ({
          path: `confluence/${space}/${page}.md`,
          content: body,
        })),
      )
    },
    matchesEvent: ({ event, scope }) =>
      spacesOf(scope).includes((event as { space?: string }).space ?? ""),
  }
  return { adapter, fetches }
}
