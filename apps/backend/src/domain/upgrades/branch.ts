import { listOpenRepositoryPullRequestsByBranchPrefix } from "../../services/github/installation-write-client.js"

type GithubInput = Parameters<
  typeof listOpenRepositoryPullRequestsByBranchPrefix
>[0]

/**
 * The open pull requests of the upgrade branch `base` and of its suffixed
 * names (`base-2`, `base-3`, ...), in that order.
 */
export async function listUpgradePullRequests(
  github: Omit<GithubInput, "branchPrefix" | "exactBranch">,
  base: string,
) {
  const pulls = await listOpenRepositoryPullRequestsByBranchPrefix({
    ...github,
    branchPrefix: base,
  })
  const suffix = (branch: string) =>
    branch === base ? 1 : Number(branch.slice(base.length + 1))
  return pulls
    .filter(
      (pull) =>
        pull.branch === base || /^-\d+$/.test(pull.branch.slice(base.length)),
    )
    .sort((a, b) => suffix(a.branch) - suffix(b.branch))
}

/**
 * The branch to push for the upgrade pull request: the branch of our own open
 * pull request, else the first name from `base`, `base-2`, `base-3`, ... that
 * no pull request of another person or App uses. ctx| never pushes over the
 * branch of a pull request it does not own.
 */
export function chooseUpgradeBranch(
  pulls: Array<{ branch: string; ours: boolean }>,
  base: string,
): string {
  const own = pulls.find((pull) => pull.ours)
  if (own) return own.branch
  const taken = new Set(pulls.map((pull) => pull.branch))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}
