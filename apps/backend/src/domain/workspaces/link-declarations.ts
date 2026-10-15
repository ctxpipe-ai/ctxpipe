import { SourceChangeError } from "../workspace-sources/edit.js"
import {
  linkGithubSourceFile,
  unlinkGithubRepository,
  unlinkGithubSourceFile,
} from "../workspace-sources/github-links.js"
import { githubSourceRepositories } from "../workspace-sources/github-sources.js"
import { SOURCE_FILES_FOLDER } from "../workspace-sources/source-file.js"
import { SOURCES_FILE_PATH } from "../workspace-sources/sources-file.js"
import {
  isLinkedRepositoryDeclaration,
  parseLinkedRepositoryMarkdown,
} from "./layout.js"
import { linkedRepositoryUrlSchema } from "./linked-repository-url.js"
import { normalizeWorkspaceRepositoryUrl } from "./slug.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

type RepoFile = { path: string; content: string }

/**
 * Link or unlink one repository (ADR-050, revision 2026-10-16). Link writes
 * `sources/github/<owner>/<name>.md` with the connection `connectionId`.
 * Unlink deletes the file of that repository. `files` holds each file under
 * `sources/`, `.ctxpipe/sources.yaml`, and the `repositories/*.md`
 * declarations, which a Workspace that has no conversion yet still has:
 * link moves the declaration of the same repository into the new file (it
 * keeps the branch as the ref), and unlink also removes the repository from
 * the legacy file and declarations. `refused` tells why the change cannot be
 * made: the repository is not on GitHub, or a file is in the way.
 */
export function changeLinkedRepository(input: {
  action: "link" | "unlink"
  gitUrl: string
  connectionId: string
  files: ReadonlyArray<RepoFile>
}): {
  files: RepoFile[]
  deletePaths: string[]
  refused: string | null
} {
  const name = githubRepoFullNameFromWorkspaceUrl(
    linkedRepositoryUrlSchema.parse(input.gitUrl),
  )
  if (!name)
    return {
      files: [],
      deletePaths: [],
      refused: "Only a GitHub repository can be linked to a Workspace",
    }
  const sourceFiles = input.files.filter((file) =>
    file.path.startsWith(`${SOURCE_FILES_FOLDER}/`),
  )
  const legacyYaml =
    input.files.find((file) => file.path === SOURCES_FILE_PATH)?.content ?? null
  // The declarations of this repository, by their normalized URL.
  const declarations = input.files.flatMap((file) => {
    if (!isLinkedRepositoryDeclaration(file.path)) return []
    const parsed = parseLinkedRepositoryMarkdown(file.content)
    if (parsed.malformed) return []
    const gitUrl = normalizeWorkspaceRepositoryUrl(parsed.git)
    return githubRepoFullNameFromWorkspaceUrl(gitUrl)?.toLowerCase() ===
      name.toLowerCase()
      ? [{ path: file.path, ref: parsed.branch }]
      : []
  })
  try {
    if (input.action === "link") {
      // A repository that the legacy file links already is a link.
      const inLegacyYaml = githubSourceRepositories(legacyYaml, null).some(
        (linked) =>
          githubRepoFullNameFromWorkspaceUrl(linked.gitUrl)?.toLowerCase() ===
          name.toLowerCase(),
      )
      if (inLegacyYaml) return { files: [], deletePaths: [], refused: null }
      const changes = linkGithubSourceFile({
        files: sourceFiles,
        connectionId: input.connectionId,
        repository: { name, ref: declarations[0]?.ref ?? null },
      })
      return {
        files: changes?.writes ?? [],
        // A declaration goes away only when its repository has a source file.
        deletePaths: declarations.map((declaration) => declaration.path),
        refused: null,
      }
    }
    const changes = unlinkGithubSourceFile({ files: sourceFiles, name })
    const yaml = unlinkGithubRepository({ sourcesFile: legacyYaml, name })
    return {
      files: yaml === null ? [] : [{ path: SOURCES_FILE_PATH, content: yaml }],
      deletePaths: [
        ...(changes?.deletes ?? []),
        ...declarations.map((declaration) => declaration.path),
      ],
      refused: null,
    }
  } catch (error) {
    if (error instanceof SourceChangeError)
      return { files: [], deletePaths: [], refused: error.message }
    throw error
  }
}
