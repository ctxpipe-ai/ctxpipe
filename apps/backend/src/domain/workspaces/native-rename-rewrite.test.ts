import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, expect, it } from "vitest"

import { captureGitPack } from "../../services/git/pack.js"
import { nativeRenameRewriteFiles } from "./native-rename-rewrite.js"

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function repository() {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-rename-test-"))
  directories.push(directory)
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: directory,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.test",
      },
    })
      .toString()
      .trim()
  git("init", "--quiet", "--initial-branch=main")
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), content)
  }
  const commit = (message: string) => {
    git("add", "-A")
    git("commit", "--quiet", "-m", message)
    return git("rev-parse", "HEAD")
  }
  return { directory, git, write, commit }
}

const SOURCE =
  "---\nprovider: github\nconnection: con_github1\nrepository: acme/shop\n---\nThe shop repository, with the checkout and the cart.\n"

it("rewrites the sources list of each unit that names a renamed source file", async () => {
  const repo = repository()
  repo.write("sources/github/acme/shop.md", SOURCE)
  repo.write(
    "knowledge/services/checkout.md",
    "---\nkind: Service\nsources:\n  - sources/github/acme/shop.md\n  - sources/linear/eng.md\n---\n# Checkout\n",
  )
  repo.write(
    "knowledge/notes/plain.md",
    "---\nsources:\n  - https://github.com/acme/shop\n---\n# Plain\n",
  )
  const before = repo.commit("Add the shop source")
  repo.git(
    "mv",
    "sources/github/acme/shop.md",
    "sources/github/acme/storefront.md",
  )
  const after = repo.commit("Rename the shop source")

  const changes = await nativeRenameRewriteFiles(
    await captureGitPack(repo.directory, after, null, [before]),
    before,
    null,
  )

  expect(changes).toEqual([
    {
      path: "knowledge/services/checkout.md",
      content:
        "---\nkind: Service\nsources:\n  - sources/github/acme/storefront.md\n  - sources/linear/eng.md\n---\n# Checkout\n",
    },
  ])
})
