import {
  type GitPack,
  type GitRemoteRead,
  listPackBlobs,
  withGitDirectory,
} from "../../services/git/pack.js"
import { githubRepoFullNameFromWorkspaceUrl } from "./write-status.js"

/**
 * The GitHub pull request and issue mirror files at the commit of `pack`.
 * `repository` is `<owner>/<repo>` in lowercase, and `lowercasePath` is the
 * path of the file in the lowercase folder. A mirror from before 2026-10-20
 * has a folder with the mixed case of GitHub.
 */
export async function listGithubMirrorFiles(
  pack: GitPack,
  read: GitRemoteRead | null,
) {
  return (
    await withGitDirectory(
      pack.sha,
      (directory) => listPackBlobs(directory, pack),
      pack,
      read,
    )
  ).flatMap(({ path }) => {
    // `github/<pulls|issues>/<owner>/<repo>/<file>`: one mirror file.
    const match = /^github\/(pulls|issues)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(
      path,
    )
    if (!match) return []
    const [, folder = "", owner = "", repo = "", name = ""] = match
    const repository = `${owner}/${repo}`.toLowerCase()
    return [
      {
        path,
        repository,
        lowercasePath: `github/${folder}/${repository}/${name}`,
      },
    ]
  })
}

/**
 * The paths of the pull request and issue mirror files of the GitHub
 * repository `repositoryUrl` at the commit of `pack` (CTX-1698). The match
 * ignores case, so a mixed-case folder from before 2026-10-20 is in the list
 * too. A repository that is not on GitHub has no mirror. The caller applies
 * the fence (`sourcesHoldRepository`) before it deletes these files.
 */
export async function githubMirrorPathsOf(input: {
  pack: GitPack
  read: GitRemoteRead | null
  repositoryUrl: string
}): Promise<string[]> {
  const repository = githubRepoFullNameFromWorkspaceUrl(input.repositoryUrl)
  if (repository === null) return []
  return (await listGithubMirrorFiles(input.pack, input.read))
    .filter((file) => file.repository === repository)
    .map((file) => file.path)
}
