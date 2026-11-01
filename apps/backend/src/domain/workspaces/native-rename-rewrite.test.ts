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

it("returns no changes when the revision renames no file", async () => {
  const repo = repository()
  repo.write("knowledge/a.md", "# A\n\n[B](./b.md)\n")
  repo.write("knowledge/b.md", "# B\n")
  const before = repo.commit("Add the two notes")
  repo.write("knowledge/b.md", "# B\n\nA new paragraph about the note.\n")
  const after = repo.commit("Edit the second note")

  const changes = await nativeRenameRewriteFiles(
    await captureGitPack(repo.directory, after, null, [before]),
    before,
    null,
  )

  expect(changes).toEqual([])
})

it("rewrites a link in another file to the new path of a renamed file", async () => {
  const repo = repository()
  repo.write("knowledge/a.md", "# A\n\n[B](./b.md)\n")
  repo.write("knowledge/b.md", "# B\n")
  const before = repo.commit("Add the two notes")
  repo.git("mv", "knowledge/b.md", "knowledge/c.md")
  const after = repo.commit("Rename the second note")

  const changes = await nativeRenameRewriteFiles(
    await captureGitPack(repo.directory, after, null, [before]),
    before,
    null,
  )

  // The relative link drops its `./` prefix, as `posix.relative` builds it.
  expect(changes).toHaveLength(1)
  expect(changes[0]?.path).toBe("knowledge/a.md")
  expect(changes[0]?.content).toContain("](c.md)")
  expect(changes[0]?.content).not.toContain("b.md")
})

// CTX-1009: the rewrite of a large Workspace held the worker event loop for
// more than half of the OpenWorkflow lease, so the worker lost the lease.
it("does not hold the event loop for most of the rewrite of a large Workspace", async () => {
  const repo = repository()
  const count = 40
  const path = (index: number) => `knowledge/topic-${index}.md`
  const paragraph = (index: number) =>
    `Topic ${index} calls [the next topic](topic-${(index + 1) % count}.md) and [a later topic](./topic-${(index + 7) % count}.md#usage), with \`code\` and *emphasis*.\n\n`
  for (let index = 0; index < count; index++)
    repo.write(
      path(index),
      `---\nkind: Service\nclaims:\n  - to: topic-${(index + 1) % count}.md\n---\n# Topic ${index}\n\n${paragraph(index).repeat(300)}`,
    )
  const before = repo.commit("Add the topics")
  repo.git("mv", path(1), "knowledge/renamed-topic.md")
  const after = repo.commit("Rename one topic")
  const pack = await captureGitPack(repo.directory, after, null, [before])

  let longestBlock = 0
  let last = performance.now()
  const probe = setInterval(() => {
    const now = performance.now()
    longestBlock = Math.max(longestBlock, now - last)
    last = now
  }, 5)
  const start = performance.now()
  try {
    const changes = await nativeRenameRewriteFiles(pack, before, null)
    const elapsed = performance.now() - start
    // The renamed topic, and the two topics that link to it, change.
    expect(changes.map((change) => change.path).sort()).toEqual([
      "knowledge/renamed-topic.md",
      path(0),
      path(34),
    ])
    expect(
      changes.find((change) => change.path === path(0))?.content,
    ).toContain("](renamed-topic.md)")
    expect(longestBlock).toBeLessThan(elapsed * 0.2)
  } finally {
    clearInterval(probe)
  }
})
