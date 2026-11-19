import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { HttpResponse, http } from "msw"
import { Octokit } from "octokit"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  freezeCorpora,
  type GithubAccess,
  importCorpusIssues,
  type Plan,
  planSchema,
  snapshotRepositories,
} from "../../evals/knowledge/corpus.js"
import { useMswServer } from "../../test/msw.js"

/*
 * The corpus steps with real git and `file://` remotes in place of GitHub,
 * and msw for the GitHub API.
 */

const API = "https://api.github.com"
const server = useMswServer()

let base: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Dev",
      GIT_AUTHOR_EMAIL: "dev@acme.test",
      GIT_COMMITTER_NAME: "Dev",
      GIT_COMMITTER_EMAIL: "dev@acme.test",
    },
  })
    .toString()
    .trim()
}

/** A bare repository at `<base>/<fullName>.git` with one commit of `files`. */
async function repository(
  fullName: string,
  files: Record<string, string>,
): Promise<string> {
  const bare = join(base, `${fullName}.git`)
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare])
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true")
  const work = await mkdtemp(join(tmpdir(), "corpus-work-"))
  git(work, "init", "-q", "-b", "main")
  for (const [path, content] of Object.entries(files))
    await writeFile(join(work, path), content)
  git(work, "add", ".")
  git(work, "commit", "-q", "-m", "First")
  git(work, "push", "-q", bare, "main")
  const sha = git(work, "rev-parse", "HEAD")
  await rm(work, { recursive: true, force: true })
  return sha
}

/** The GitHub repository API of the org `evals`, backed by bare repositories. */
function serveOrg(): string[] {
  const created: string[] = []
  server.use(
    http.get(`${API}/repos/evals/:name`, ({ params }) =>
      created.includes(String(params.name))
        ? HttpResponse.json({ private: true })
        : HttpResponse.json({ message: "Not Found" }, { status: 404 }),
    ),
    http.post(`${API}/orgs/evals/repos`, async ({ request }) => {
      const body = (await request.json()) as { name: string; private: boolean }
      expect(body.private).toBe(true)
      execFileSync("git", [
        "init",
        "-q",
        "--bare",
        "-b",
        "main",
        join(base, "evals", `${body.name}.git`),
      ])
      created.push(body.name)
      return HttpResponse.json({ private: true }, { status: 201 })
    }),
  )
  return created
}

function plan(sha: string, issues = 0): Plan {
  return {
    version: "0-test",
    cutoff: "2026-06-01T00:00:00Z",
    owner: "evals",
    prefix: "v0-",
    corpora: [
      {
        id: "demo",
        workspace: "demo-v0",
        repositories: [{ source: "acme/api", sha, issues }],
      },
    ],
  }
}

function access(): GithubAccess {
  return { octokit: new Octokit(), gitBase: `file://${base}` }
}

const quiet = () => {}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "corpus-"))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe("snapshotRepositories", () => {
  it("pushes the tree at the SHA as one commit with no personal data", async () => {
    const sha = await repository("acme/api", { "README.md": "# API\n" })
    const created = serveOrg()

    const [snapshot] = await snapshotRepositories(plan(sha), access(), quiet)

    const target = join(base, "evals", "v0-demo-api.git")
    expect(created).toEqual(["v0-demo-api"])
    expect(snapshot).toMatchObject({
      corpus: "demo",
      source: "acme/api",
      sha,
      repository: "evals/v0-demo-api",
    })
    expect(git(target, "rev-parse", "main")).toBe(snapshot?.snapshotSha)
    expect(git(target, "rev-parse", "main^{tree}")).toBe(
      git(join(base, "acme/api.git"), "rev-parse", `${sha}^{tree}`),
    )
    expect(git(target, "log", "--format=%an <%ae> %aI", "main")).toBe(
      "ctxpipe evals <evals@ctxpipe.invalid> 2026-06-01T00:00:00Z",
    )
    expect(git(target, "rev-list", "--count", "main")).toBe("1")

    // The same plan gives the same commit, so a second run pushes nothing.
    const [again] = await snapshotRepositories(plan(sha), access(), quiet)
    expect(again?.snapshotSha).toBe(snapshot?.snapshotSha)
    expect(created).toHaveLength(1)
  })

  it("refuses a snapshot repository that holds another commit", async () => {
    const first = await repository("acme/api", { "README.md": "# API\n" })
    serveOrg()
    await snapshotRepositories(plan(first), access(), quiet)
    const work = await mkdtemp(join(tmpdir(), "corpus-work-"))
    git(work, "clone", "-q", join(base, "acme/api.git"), ".")
    await writeFile(join(work, "README.md"), "# API v2\n")
    git(work, "commit", "-q", "-am", "Second")
    git(work, "push", "-q", "origin", "main")
    const second = git(work, "rev-parse", "HEAD")
    await rm(work, { recursive: true, force: true })

    await expect(
      snapshotRepositories(plan(second), access(), quiet),
    ).rejects.toThrow("evals/v0-demo-api holds another snapshot")
  })
})

describe("importCorpusIssues and freezeCorpora", () => {
  it("writes the stamped issue files, then freezes the context repo SHA", async () => {
    const sha = await repository("acme/api", { "README.md": "# API\n" })
    await repository("evals/v0-demo-context", { ".ctxpipe": "format: 3\n" })
    server.use(
      http.get(`${API}/repos/acme/api`, () =>
        HttpResponse.json({ private: false, visibility: "public" }),
      ),
      http.get(`${API}/repos/acme/api/issues`, () =>
        HttpResponse.json([
          {
            node_id: "I_1",
            number: 1,
            html_url: "https://github.com/acme/api/issues/1",
            title: "Problem",
            body: "Steps.",
            state: "open",
            state_reason: null,
            user: { login: "bob", type: "User" },
            labels: [],
            assignees: [],
            comments: 0,
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-01T00:00:00Z",
            closed_at: null,
          },
        ]),
      ),
    )

    const counts = await importCorpusIssues(plan(sha, 5), access(), quiet)

    expect(counts).toEqual([{ corpus: "demo", source: "acme/api", issues: 1 }])
    const context = join(base, "evals", "v0-demo-context.git")
    const file = git(context, "show", "main:github/issues/acme/api/1.md")
    expect(file).toContain("# Problem")
    expect(file).toContain(
      "sources:\n  - sources/github/evals/v0-demo-api.md\n---",
    )
    expect(git(context, "log", "--format=%ae", "-1", "main")).toBe(
      "evals@ctxpipe.invalid",
    )

    const dataset = join(base, "dataset.json")
    await writeFile(
      dataset,
      JSON.stringify({ version: "0", corpora: [], questions: ["kept"] }),
    )
    await freezeCorpora(plan(sha), access(), dataset)

    expect(JSON.parse(await readFile(dataset, "utf8"))).toEqual({
      version: "0",
      questions: ["kept"],
      corpora: [
        {
          id: "demo",
          source: `acme/api@${sha}`,
          contextRepo: {
            url: "https://github.com/evals/v0-demo-context",
            sha: git(context, "rev-parse", "main"),
          },
          workspace: "demo-v0",
        },
      ],
    })
  })
})

it("the committed plan of version 0 is valid", async () => {
  const file = new URL(
    "../../evals/knowledge/fixtures/corpora-v0.plan.json",
    import.meta.url,
  )
  expect(() =>
    planSchema.parse(JSON.parse(readFileSync(file, "utf8"))),
  ).not.toThrow()
})
