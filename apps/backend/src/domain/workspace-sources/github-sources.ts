import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import type { SourceFileBlob } from "./projection-plan.js"
import {
  githubScopeRepositories,
  githubScopeSchema,
} from "./providers/github.js"
import { parseSourceFile } from "./source-file-text.js"
import {
  parseSourceEntry,
  SOURCES_FILE_PATH,
  sourcesFileSchema,
} from "./sources-file.js"
import { parseSourcesYaml } from "./sources-yaml.js"

function githubUrl(repositoryName: string): string {
  return normalizeWorkspaceRepositoryUrl(`https://github.com/${repositoryName}`)
}

export type DeclaredGithubRepository = {
  gitUrl: string
  ref: string | null
  connectionId: string
  /** The file that declares it: `.ctxpipe/sources.yaml` or a source file. */
  path: string
}

/**
 * The linked repositories that the GitHub sources of a Workspace declare,
 * each with its ref and the connection that reads it: first the entries of
 * `.ctxpipe/sources.yaml` (until CTX-721 T11), then the GitHub source files
 * under `sources/github/` in byte order. When `connectionIds` (the org's
 * GitHub connections) is set, only a source whose connection is one of them
 * links its repositories. An invalid file or entry declares nothing; the
 * projection shows its error.
 */
export function githubSourceRepositories(
  text: string | null,
  connectionIds: ReadonlySet<string> | null,
  sourceFiles: ReadonlyArray<SourceFileBlob> = [],
): DeclaredGithubRepository[] {
  const allowed = (connectionId: string) =>
    connectionIds === null || connectionIds.has(connectionId)
  const fromFiles = [...sourceFiles]
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .flatMap((file) => {
      if (!file.path.startsWith("sources/github/")) return []
      const parsed = parseSourceFile(file.path, file.text)
      if (!parsed.ok || !allowed(parsed.source.connectionId)) return []
      const { repository, ref } = parsed.source.scope as {
        repository: string
        ref?: string
      }
      return [
        {
          gitUrl: githubUrl(repository),
          ref: ref ?? null,
          connectionId: parsed.source.connectionId,
          path: file.path,
        },
      ]
    })
  return [...yamlRepositories(text, allowed), ...fromFiles]
}

function yamlRepositories(
  text: string | null,
  allowed: (connectionId: string) => boolean,
): DeclaredGithubRepository[] {
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
      !allowed(parsed.entry.connectionId)
    )
      return []
    return githubScopeRepositories(
      githubScopeSchema.parse(parsed.entry.scope),
    ).map(({ name, ref }) => ({
      gitUrl: githubUrl(name),
      ref,
      connectionId: parsed.entry.connectionId,
      path: SOURCES_FILE_PATH,
    }))
  })
}
