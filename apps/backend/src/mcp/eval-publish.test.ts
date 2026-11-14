import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  mcpEvalManifest,
  prepareMcpEvalRepositories,
  publishedFixtureDifferences,
  publishMcpEvalRepositories,
} from "../../evals/mcp/seed.js"

/*
 * The published fixture repositories of a deployed eval run (CTX-1217), with
 * real Git: local bare repositories stand in for the GitHub ones.
 */

let root: string
const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim()

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "mcp-eval-publish-"))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** One empty bare repository for each fixture Workspace, as GitHub makes them. */
function emptyRemotes(name: string): Record<string, string> {
  return Object.fromEntries(
    mcpEvalManifest.workspaces.map(({ key }) => {
      const path = join(root, name, `${key}.git`)
      git("init", "--bare", "--quiet", "--initial-branch=main", path)
      return [key, pathToFileURL(path).href]
    }),
  )
}

describe("published fixture repositories", () => {
  it("makes the same commits on each run, so a fresh copy matches", async () => {
    const published = await prepareMcpEvalRepositories(join(root, "first"))

    const { differences, commits } = await publishedFixtureDifferences(
      published,
      join(root, "second"),
    )

    expect(differences).toEqual([])
    // The checked commit of each repository is its published main.
    for (const [key, url] of Object.entries(published))
      expect(commits[key]).toBe(
        git("--git-dir", fileURLToPath(url), "rev-parse", "main"),
      )
  })

  it("names each branch that an empty repository lacks", async () => {
    const remotes = emptyRemotes("empty")

    const { differences } = await publishedFixtureDifferences(
      remotes,
      join(root, "check-empty"),
    )

    // main of each repository, and the branch of the second projection.
    expect(differences).toHaveLength(mcpEvalManifest.workspaces.length + 1)
    expect(differences[0]).toMatch(/^harbor-payments main: published nothing/)
  })

  it("publishes each branch, and then finds no difference", async () => {
    const remotes = emptyRemotes("published")

    await publishMcpEvalRepositories(remotes, join(root, "publish"))

    expect(
      (await publishedFixtureDifferences(remotes, join(root, "check")))
        .differences,
    ).toEqual([])
    const second = mcpEvalManifest.secondProjection
    const bare = fileURLToPath(remotes[second.workspace] ?? "")
    expect(git("--git-dir", bare, "branch", "--list")).toContain(second.branch)
  })
})
