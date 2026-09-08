import {
  isLinkedRepositoryDeclaration,
  parseLinkedRepositoryMarkdown,
} from "./layout.js"
import {
  displayNameFromGitUrl,
  normalizeSlug,
  normalizeWorkspaceRepositoryUrl,
} from "./slug.js"

/** Edit the canonical declaration, preserving every other repository's document. */
export function changeLinkedRepository(input: {
  files: ReadonlyArray<{ path: string; content: string }>
  action: "link" | "unlink"
  gitUrl: string
}): { files: Array<{ path: string; content: string }>; deletePaths: string[] } {
  const target = normalizeWorkspaceRepositoryUrl(input.gitUrl)
  const matches = input.files.filter((file) => {
    if (!isLinkedRepositoryDeclaration(file.path)) return false
    const parsed = parseLinkedRepositoryMarkdown(file.content)
    return (
      !parsed.malformed &&
      normalizeWorkspaceRepositoryUrl(parsed.git) === target
    )
  })
  if (input.action === "unlink")
    return { files: [], deletePaths: matches.map((file) => file.path) }
  if (matches.length) return { files: [], deletePaths: [] }
  const name = normalizeSlug(displayNameFromGitUrl(input.gitUrl))
  const occupied = new Set(input.files.map((file) => file.path))
  let suffix = 1
  let path = `repositories/${name}.md`
  while (occupied.has(path)) path = `repositories/${name}-${++suffix}.md`
  return {
    files: [
      {
        path,
        content: `---\ngit: ${JSON.stringify(input.gitUrl.trim())}\n---\n`,
      },
    ],
    deletePaths: [],
  }
}
