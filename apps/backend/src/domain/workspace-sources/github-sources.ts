import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import { githubScopeSchema } from "./providers/github.js"
import { parseSourceEntry, sourcesFileSchema } from "./sources-file.js"
import { parseSourcesYaml } from "./sources-yaml.js"

function githubUrl(repositoryName: string): string {
  return normalizeWorkspaceRepositoryUrl(`https://github.com/${repositoryName}`)
}

/**
 * The linked repositories that the GitHub entries of `.ctxpipe/sources.yaml`
 * declare, each with the connection that reads it. An invalid file or entry
 * declares nothing; the projection shows its error.
 */
export function githubSourceRepositories(
  text: string | null,
): Array<{ gitUrl: string; connectionId: string }> {
  if (text === null) return []
  let document: unknown
  try {
    document = parseSourcesYaml(text)
  } catch {
    return []
  }
  const file = sourcesFileSchema.safeParse(document)
  if (!file.success) return []
  return file.data.sources.flatMap((raw) => {
    const parsed = parseSourceEntry(raw)
    if (!parsed.ok || parsed.entry.provider !== "github") return []
    const { repositories } = githubScopeSchema.parse(parsed.entry.scope)
    return repositories.map((name) => ({
      gitUrl: githubUrl(name),
      connectionId: parsed.entry.connectionId,
    }))
  })
}

const NO_ACCESS_PREFIX = "ctx| has no access to these repositories: "
const NO_ACCESS_SUFFIX =
  ". Add them to the GitHub App installation of this connection."

/** The `out_of_access` detail of a GitHub source row. */
export function githubNoAccessDetail(repositoryNames: string[]): string {
  return `${NO_ACCESS_PREFIX}${repositoryNames.join(", ")}${NO_ACCESS_SUFFIX}`
}

/**
 * The repository URLs that a GitHub source row's `out_of_access` detail
 * names. The tip check skips them until a new projection checks again.
 */
export function repositoriesWithoutAccess(detail: string | null): string[] {
  if (
    !detail?.startsWith(NO_ACCESS_PREFIX) ||
    !detail.endsWith(NO_ACCESS_SUFFIX)
  )
    return []
  return detail
    .slice(NO_ACCESS_PREFIX.length, -NO_ACCESS_SUFFIX.length)
    .split(", ")
    .filter(Boolean)
    .map(githubUrl)
}
