/**
 * Writes the issue mirror files of a public GitHub repository into a
 * directory, for an eval corpus (CTX-1393, ADR-069). The files are the same
 * as the production issue mirror writes. Only public data is read.
 *
 * Usage (apps/backend):
 *   bun run src/scripts/importPublicGithubIssues.ts --repository <owner/repo>
 *     --until <ISO time> --out <directory> [--since <ISO time>] [--limit <n>]
 *
 * `--until` is the cut-off: the issues created up to it, as they were at
 * that time. `--since` is the earliest creation time. The files go to
 * `<directory>/github/issues/<owner>/<repo>/<number>.md`.
 *
 * Env: `GITHUB_TOKEN` is optional. Without it, GitHub allows 60 requests
 * per hour; with it, 5000. Use a token that can only read public data.
 */
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Octokit } from "octokit"

import { importPublicGithubIssues } from "../services/github/issue-mirror/public-import.js"
import { flag } from "./cli-args.js"

function date(value: string | undefined, name: string): Date | undefined {
  if (value === undefined) return undefined
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new Error(`${name} is not a date`)
  return parsed
}

async function main(argv: string[]): Promise<void> {
  const repository = flag(argv, "--repository")
  const until = date(flag(argv, "--until"), "--until")
  const out = flag(argv, "--out")
  if (!repository || !until || !out)
    throw new Error("--repository, --until and --out are required")
  const limit = flag(argv, "--limit")
  // Wait for the rate limit to reset, then continue.
  const wait = (retryAfter: number) => {
    process.stderr.write(`GitHub rate limit: waiting ${retryAfter} s\n`)
    return true
  }
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN || undefined,
    throttle: { onRateLimit: wait, onSecondaryRateLimit: wait },
  })
  let issues = 0
  for await (const file of importPublicGithubIssues({
    octokit,
    repository,
    until,
    since: date(flag(argv, "--since"), "--since"),
    limit: limit ? Number(limit) : undefined,
  })) {
    const path = join(out, file.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.content)
    issues += 1
  }
  process.stderr.write(`${repository}: ${issues} issues\n`)
}

// No evlog: it reads the server env, which this script does not need.
main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
