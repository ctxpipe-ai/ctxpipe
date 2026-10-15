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
 * link also moves each declaration into a source file (it keeps the branch
 * as the ref), and unlink also removes the repository from the legacy file
 * and the declarations. `refused` tells why the change cannot be
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
  const sameName = (left: string, right: string) =>
    left.toLowerCase() === right.toLowerCase()
  // Each GitHub declaration, with its repository name and branch.
  const declarations = input.files.flatMap((file) => {
    if (!isLinkedRepositoryDeclaration(file.path)) return []
    const parsed = parseLinkedRepositoryMarkdown(file.content)
    if (parsed.malformed) return []
    const declared = githubRepoFullNameFromWorkspaceUrl(
      normalizeWorkspaceRepositoryUrl(parsed.git),
    )
    return declared
      ? [{ path: file.path, name: declared, ref: parsed.branch }]
      : []
  })
  const legacyLinked = (repository: string) =>
    githubSourceRepositories(legacyYaml, null).some((linked) => {
      const linkedName = githubRepoFullNameFromWorkspaceUrl(linked.gitUrl)
      return linkedName !== null && sameName(linkedName, repository)
    })
  try {
    if (input.action === "link") {
      // The link edit also moves each repository file into a source file
      // (the declarations of a Workspace that is not converted yet). The
      // repository of this edit comes last. A repository that the legacy
      // file links needs no source file.
      let current = [...sourceFiles]
      const writes: RepoFile[] = []
      const wanted = [...declarations, { name, ref: null as string | null }]
      for (const item of wanted) {
        if (legacyLinked(item.name)) continue
        const known = wanted.find((other) => sameName(other.name, item.name))
        if (known !== item) continue
        const changes = linkGithubSourceFile({
          files: current,
          connectionId: input.connectionId,
          repository: item,
        })
        if (!changes) continue
        writes.push(...changes.writes)
        current = [
          ...current.filter(
            (file) => !changes.writes.some((write) => write.path === file.path),
          ),
          ...changes.writes,
        ]
      }
      return {
        files: writes,
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
        ...declarations
          .filter((declaration) => sameName(declaration.name, name))
          .map((declaration) => declaration.path),
      ],
      refused: null,
    }
  } catch (error) {
    if (error instanceof SourceChangeError)
      return { files: [], deletePaths: [], refused: error.message }
    throw error
  }
}
