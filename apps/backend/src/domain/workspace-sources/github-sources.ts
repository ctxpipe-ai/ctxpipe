import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import {
  githubScopeRepositories,
  githubScopeSchema,
} from "./providers/github.js"
import { parseSourceEntry, sourcesFileSchema } from "./sources-file.js"
import { parseSourcesYaml } from "./sources-yaml.js"

function githubUrl(repositoryName: string): string {
  return normalizeWorkspaceRepositoryUrl(`https://github.com/${repositoryName}`)
}

/**
 * The linked repositories that the GitHub entries of `.ctxpipe/sources.yaml`
 * declare, each with its ref and the connection that reads it. When
 * `connectionIds` (the org's GitHub connections) is set, only an entry whose
 * connection is one of them links its repositories. An invalid file or entry declares nothing; the
 * projection shows its error.
 */
export function githubSourceRepositories(
  text: string | null,
  connectionIds: ReadonlySet<string> | null,
): Array<{ gitUrl: string; ref: string | null; connectionId: string }> {
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
    if (
      !parsed.ok ||
      parsed.entry.provider !== "github" ||
      (connectionIds !== null && !connectionIds.has(parsed.entry.connectionId))
    )
      return []
    return githubScopeRepositories(
      githubScopeSchema.parse(parsed.entry.scope),
    ).map(({ name, ref }) => ({
      gitUrl: githubUrl(name),
      ref,
      connectionId: parsed.entry.connectionId,
    }))
  })
}
