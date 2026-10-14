import { SourceChangeError } from "../workspace-sources/edit.js"
import {
  linkGithubRepositories,
  unlinkGithubRepository,
} from "../workspace-sources/github-links.js"
import { SOURCES_FILE_PATH } from "../workspace-sources/sources-file.js"
import { linkedRepositoryUrlSchema } from "./linked-repository-url.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

/**
 * Link or unlink one repository in `.ctxpipe/sources.yaml` (ADR-050). Link
 * adds it to a GitHub source of `connectionId`; unlink removes it from each
 * GitHub source. `refused` tells why the change cannot go into the file: the
 * repository is not on GitHub, or the file is not valid.
 */
export function changeLinkedRepository(input: {
  sourcesFile: string | null
  action: "link" | "unlink"
  gitUrl: string
  connectionId: string
}): {
  files: Array<{ path: string; content: string }>
  refused: string | null
} {
  const name = githubRepoFullNameFromWorkspaceUrl(
    linkedRepositoryUrlSchema.parse(input.gitUrl),
  )
  if (!name)
    return {
      files: [],
      refused: "Only a GitHub repository can be linked to a Workspace",
    }
  let text: string | null
  try {
    text =
      input.action === "link"
        ? linkGithubRepositories({
            sourcesFile: input.sourcesFile,
            connectionId: input.connectionId,
            repositories: [{ name, ref: null }],
          })
        : unlinkGithubRepository({ sourcesFile: input.sourcesFile, name })
  } catch (error) {
    if (error instanceof SourceChangeError)
      return { files: [], refused: error.message }
    throw error
  }
  return {
    files: text === null ? [] : [{ path: SOURCES_FILE_PATH, content: text }],
    refused: null,
  }
}
