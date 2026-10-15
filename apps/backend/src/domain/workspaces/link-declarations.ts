import { SourceChangeError } from "../workspace-sources/edit.js"
import {
  linkGithubRepositories,
  unlinkGithubRepository,
} from "../workspace-sources/github-links.js"
import { SOURCES_FILE_PATH } from "../workspace-sources/sources-file.js"
import { linkedRepositoryUrlSchema } from "./linked-repository-url.js"
import { upgradeLinkedRepositories } from "./migration-export.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

/**
 * Link or unlink one repository in `.ctxpipe/sources.yaml` (ADR-050). Link
 * adds it to a GitHub source of `connectionId`; unlink removes it from each
 * GitHub source. Before the edit, the GitHub `repositories/*.md` files in
 * `files` move into the sources file (the upgrade of ADR-050), so the edit
 * also converts a Workspace that the export did not convert. `refused` tells
 * why the change cannot go into the file: the repository is not on GitHub,
 * or the file is not valid.
 */
export function changeLinkedRepository(input: {
  sourcesFile: string | null
  action: "link" | "unlink"
  gitUrl: string
  connectionId: string
  files?: ReadonlyArray<{ path: string; content: string }>
}): {
  files: Array<{ path: string; content: string }>
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
  const upgrade = upgradeLinkedRepositories({
    sourcesFile: input.sourcesFile,
    connectionId: input.connectionId,
    files: input.files ?? [],
  })
  const upgraded = upgrade.sourcesFile ?? input.sourcesFile
  let text: string | null
  try {
    text =
      input.action === "link"
        ? linkGithubRepositories({
            sourcesFile: upgraded,
            connectionId: input.connectionId,
            repositories: [{ name, ref: null }],
          })
        : unlinkGithubRepository({ sourcesFile: upgraded, name })
  } catch (error) {
    if (error instanceof SourceChangeError)
      return { files: [], deletePaths: [], refused: error.message }
    throw error
  }
  const content = text ?? upgrade.sourcesFile
  return {
    files: content === null ? [] : [{ path: SOURCES_FILE_PATH, content }],
    deletePaths: upgrade.deletePaths,
    refused: null,
  }
}
