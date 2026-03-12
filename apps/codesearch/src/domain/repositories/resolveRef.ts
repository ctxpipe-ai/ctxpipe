import { authenticatedGitUrl } from "../../utils/git.js"

async function runCommand(
  cmd: string[],
  env?: Record<string, string | undefined>,
): Promise<string> {
  const subprocess = Bun.spawn(cmd, {
    env,
    stdout: "pipe",
    stderr: "pipe",
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

async function resolveDefaultBranch(
  gitUrl: string,
  githubToken?: string,
): Promise<string> {
  const authUrl = authenticatedGitUrl(gitUrl, githubToken)
  let stdout: string
  try {
    stdout = await runCommand(["git", "ls-remote", "--symref", authUrl, "HEAD"])
  } catch (error) {
    console.error("resolveDefaultBranch: git ls-remote failed", {
      gitUrl,
      error: error instanceof Error ? error.message : error,
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
  gitUrl: string,
  branch: string,
  githubToken?: string,
): Promise<string> {
  const authUrl = authenticatedGitUrl(gitUrl, githubToken)
  const stdout = await runCommand([
    "git",
    "ls-remote",
    authUrl,
    `refs/heads/${branch}`,
  ])
  const firstLine = stdout.split("\n")[0] ?? ""
  const hash = firstLine.split("\t")[0]
  if (!hash) {
    throw new Error(`Could not resolve hash for branch: ${branch}`)
  }
  return hash
}

export async function resolveRepositoryRef(input: {
  gitUrl: string
  branch?: string
  githubToken?: string
}): Promise<{ branch: string; hash: string }> {
  const branch =
    input.branch && input.branch.trim().length > 0
      ? input.branch.trim()
      : await resolveDefaultBranch(input.gitUrl, input.githubToken)

  const hash = await resolveBranchHash(input.gitUrl, branch, input.githubToken)
  return { branch, hash }
}
