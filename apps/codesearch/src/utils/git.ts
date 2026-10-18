import {
  type PinnedPlainGitRemote,
  pinnedPlainGitRemoteFault,
  plainGitRemoteEnvironment,
} from "../../../../shared/plain-git.js"

function isGitHubUrl(gitUrl: string): boolean {
  if (gitUrl.startsWith("git@github.com:")) return true
  try {
    const parsed = new URL(gitUrl)
    return parsed.hostname === "github.com"
  } catch {
    return false
  }
}

/**
 * Removes a user name and password from an HTTP(S) remote URL, so that Git
 * does not write a credential into `.git/config`.
 */
export function credentialFreeGitUrl(gitUrl: string): string {
  if (!URL.canParse(gitUrl)) return gitUrl
  const url = new URL(gitUrl)
  if (!["http:", "https:"].includes(url.protocol)) return gitUrl
  if (!url.username && !url.password) return gitUrl
  url.username = ""
  url.password = ""
  return url.toString()
}

/**
 * The environment for a Git command against `gitUrl`. When a GitHub token is
 * given, an inline credential helper gives the token to Git from the
 * environment, with the `x-access-token` user that GitHub documents for App
 * installation tokens. The helper applies only to the scheme and host of
 * `gitUrl`, so Git follows a redirect on that host but never gives the token
 * to another host. The empty helper first removes the other helpers, so no
 * keychain stores the token. Git never prompts for a credential.
 */
export function gitCommandEnv(
  gitUrl: string,
  githubToken?: string,
): Record<string, string | undefined> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" }
  if (!githubToken || !isGitHubUrl(gitUrl) || !URL.canParse(gitUrl)) return env
  const remote = new URL(gitUrl)
  if (!["http:", "https:"].includes(remote.protocol)) return env
  return {
    ...env,
    CTXPIPE_GIT_TOKEN: githubToken,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: `credential.${remote.protocol}//${remote.host}.helper`,
    GIT_CONFIG_VALUE_1:
      '!f() { test "$1" = get || return 0; echo username=x-access-token; echo "password=$CTXPIPE_GIT_TOKEN"; }; f',
  }
}

/**
 * The remote of one git network command: the URL, the environment, and,
 * for a plain git remote, the limits of the command.
 */
export type GitRemote = {
  url: string
  env: Record<string, string | undefined>
  limits?: PlainGitLimits
}

/** The limits of one git network command on a plain git remote. */
export type PlainGitLimits = {
  /** The time limit of the command; then codesearch kills git. */
  timeoutMs: number
  /** The size limit of each file that git writes (a pack, a checkout file). */
  maxFileBytes: number
  /** Git config after the fixed config (tests only). */
  config?: ReadonlyArray<readonly [string, string]>
}

let plainGitLimits: PlainGitLimits = {
  timeoutMs: 30 * 60_000,
  maxFileBytes: 4 * 1024 * 1024 * 1024,
}

/**
 * Tests only: the limits and the git config of each plain git command of
 * this process. Returns the function that puts the defaults back.
 */
export function usePlainGitLimits(next: Partial<PlainGitLimits>): () => void {
  const before = plainGitLimits
  plainGitLimits = { ...before, ...next }
  return () => {
    plainGitLimits = before
  }
}

/** A repository that codesearch must not read, with the reason. */
export class GitRemoteRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GitRemoteRefusedError"
  }
}

/**
 * The remote that codesearch reads for a repository (CTX-815):
 *
 * - With a GitHub token and a GitHub URL: the stored URL, with the token in
 *   a credential helper ({@link gitCommandEnv}).
 * - With a plain git remote that the backend checked: its checked URL, never
 *   the stored URL, with the shared plain git environment (no redirect, only
 *   HTTPS or self-host `http`, no system or global config, the checked
 *   addresses only, a low-speed limit) and a time and size limit. Codesearch
 *   checks the remote again before it uses it.
 * - Each other case is refused: codesearch never reads a stored URL with
 *   the git defaults (a redirect, `file://`, ssh, a proxy, global config).
 */
export function repositoryGitRemote(input: {
  gitUrl: string
  githubToken?: string
  plainGit?: PinnedPlainGitRemote
}): GitRemote {
  if (input.plainGit) {
    const fault = pinnedPlainGitRemoteFault(input.plainGit)
    if (fault) throw new GitRemoteRefusedError(fault)
    const { url, policy } = input.plainGit
    return {
      url,
      env: plainGitRemoteEnvironment(input.plainGit, {
        allowHttp: policy.http && url.startsWith("http://"),
        extra: plainGitLimits.config,
      }),
      limits: plainGitLimits,
    }
  }
  if (input.githubToken && isGitHubUrl(input.gitUrl))
    return {
      url: credentialFreeGitUrl(input.gitUrl),
      env: gitCommandEnv(input.gitUrl, input.githubToken),
    }
  throw new GitRemoteRefusedError(
    "Codesearch reads a repository only with a GitHub token or with a plain git remote that the backend checked",
  )
}
