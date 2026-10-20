import { log } from "../../observability/logger.js"
import type { GitRemote } from "../../utils/git.js"

async function runCommand(cmd: string[], remote: GitRemote): Promise<string> {
  // A plain git remote has a time limit; Bun kills git after it.
  const subprocess = Bun.spawn(cmd, {
    env: remote.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: remote.limits?.timeoutMs,
    killSignal: "SIGKILL",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(
      [
        `Command failed with exit code ${exitCode}`,
        stderr.trim() ? `stderr: ${stderr.trim()}` : "",
        stdout.trim() ? `stdout: ${stdout.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }
  return stdout
}

async function resolveDefaultBranch(remote: GitRemote): Promise<string> {
  let stdout: string
  try {
    stdout = await runCommand(
      ["git", "ls-remote", "--symref", "--", remote.url, "HEAD"],
      remote,
    )
  } catch (error) {
    log.error({
      step: "resolveDefaultBranch",
      gitUrl: remote.url,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
  const firstLine = stdout.split("\n")[0] ?? ""
  const match = firstLine.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/)
  if (!match || !match[1]) {
    throw new Error("Could not resolve default branch from remote HEAD")
  }
  return match[1]
}

async function resolveBranchHash(
  remote: GitRemote,
  branch: string,
): Promise<string> {
  const stdout = await runCommand(
    ["git", "ls-remote", "--", remote.url, `refs/heads/${branch}`],
    remote,
  )
  const firstLine = stdout.split("\n")[0] ?? ""
  const hash = firstLine.split("\t")[0]
  if (!hash) {
    throw new Error(`Could not resolve hash for branch: ${branch}`)
  }
  return hash
}

/**
 * The branch and its tip on `remote` (see `repositoryGitRemote`): the
 * requested branch, or the default branch of the remote.
 */
export async function resolveRepositoryRef(input: {
  remote: GitRemote
  branch?: string
}): Promise<{ branch: string; hash: string }> {
  const branch =
    input.branch && input.branch.trim().length > 0
      ? input.branch.trim()
      : await resolveDefaultBranch(input.remote)

  const hash = await resolveBranchHash(input.remote, branch)
  return { branch, hash }
}
