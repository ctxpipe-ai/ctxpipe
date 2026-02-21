function isGitHubUrl(gitUrl: string): boolean {
  if (gitUrl.startsWith("git@github.com:")) return true
  try {
    const parsed = new URL(gitUrl)
    return parsed.hostname === "github.com"
  } catch {
    return false
  }
}

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

function gitAuthArgs(gitUrl: string, githubToken?: string): string[] {
  if (!githubToken || !isGitHubUrl(gitUrl)) {
    return []
  }
  return ["-c", `http.extraHeader=Authorization: Bearer ${githubToken}`]
}

async function resolveDefaultBranch(
  gitUrl: string,
  githubToken?: string,
): Promise<string> {
  const stdout = await runCommand([
    "git",
    ...gitAuthArgs(gitUrl, githubToken),
    "ls-remote",
    "--symref",
    gitUrl,
    "HEAD",
  ])
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
  const stdout = await runCommand([
    "git",
    ...gitAuthArgs(gitUrl, githubToken),
    "ls-remote",
    gitUrl,
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
