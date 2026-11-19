/**
 * Writes the issue mirror files of a public GitHub repository into a
 * directory, for an eval corpus (CTX-1393, ADR-069). The files are the same
 * as the production issue mirror writes. Only public data is read.
 *
 * Usage (apps/backend):
 *   pnpm import-public-github-issues --repository <owner/repo>
 *     --until <ISO time> --out <directory> [--limit <n>]
 *
 * The package script runs Bun with `--no-env-file`, so that no `.env` file
 * (a credential file) gives the token. Export `GITHUB_TOKEN` in the shell.
 *
 * `--until` is the cut-off: the issues created up to it, as they were at
 * that time. `--limit` keeps only the newest issues. The files go to
 * `<directory>/github/issues/<owner>/<repo>/<number>.md`.
 *
 * Env: `GITHUB_TOKEN` is optional. Without it, GitHub allows 60 requests
 * per hour; with it, 5000. Use a token that can only read public data.
 * The importer refuses a repository that is not public.
 */
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Octokit } from "octokit"

import { importPublicGithubIssues } from "../services/github/issue-mirror/public-import.js"
import { flag } from "./cli-args.js"

function untilFlag(argv: string[]): Date {
  const until = new Date(flag(argv, "--until") ?? "")
  if (Number.isNaN(until.getTime())) throw new Error("--until must be a date")
  return until
}

function limitFlag(argv: string[]): number | undefined {
  const value = flag(argv, "--limit")
  if (value === undefined) return undefined
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("--limit must be a positive integer")
  return limit
}

async function main(argv: string[]): Promise<void> {
  const repository = flag(argv, "--repository")
  const out = flag(argv, "--out")
  if (!repository || !out)
    throw new Error("--repository and --out are required")
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
    until: untilFlag(argv),
    limit: limitFlag(argv),
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
