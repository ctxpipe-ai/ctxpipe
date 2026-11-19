import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

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
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true })
    await writeFile(join(work, path), content)
  }
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
    http.put(
      `${API}/repos/evals/:name/actions/permissions`,
      async ({ params, request }) => {
        const body = (await request.json()) as { enabled: boolean }
        if (!body.enabled) actionsOff.add(String(params.name))
        return new HttpResponse(null, { status: 204 })
      },
    ),
    http.get(`${API}/repos/evals/:name/actions/permissions`, ({ params }) =>
      HttpResponse.json({ enabled: !actionsOff.has(String(params.name)) }),
    ),
  )
  return created
}

const actionsOff = new Set<string>()

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
  actionsOff.clear()
  base = await mkdtemp(join(tmpdir(), "corpus-"))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe("snapshotRepositories", () => {
  it("pushes the tree at the SHA as one commit with no personal data", async () => {
    const sha = await repository("acme/api", {
      "README.md": "# API\n",
      ".github/workflows/ci.yml": "on: push\n",
      ".github/dependabot.yml": "version: 2\n",
      "renovate.json": "{}\n",
      ".github/CODEOWNERS": "* @acme\n",
    })
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
    // No workflow of another project may run in our org.
    expect(git(target, "ls-tree", "-r", "--name-only", "main")).toBe(
      ".github/CODEOWNERS\nREADME.md",
    )
    expect(actionsOff.has("v0-demo-api")).toBe(true)
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

  it("refuses a snapshot repository with another branch", async () => {
    const sha = await repository("acme/api", { "README.md": "# API\n" })
    serveOrg()
    await snapshotRepositories(plan(sha), access(), quiet)
    const target = join(base, "evals", "v0-demo-api.git")
    git(target, "branch", "master", "main")

    await expect(
      snapshotRepositories(plan(sha), access(), quiet),
    ).rejects.toThrow("holds another snapshot (refs/heads/master)")
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
      JSON.stringify({
        version: "0",
        corpora: [{ id: "other" }, { id: "demo", stale: true }],
        questions: ["kept"],
      }),
    )
    await freezeCorpora(plan(sha), access(), dataset)

    expect(JSON.parse(await readFile(dataset, "utf8"))).toEqual({
      version: "0",
      questions: ["kept"],
      corpora: [
        { id: "other" },
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

it("imports nothing and pushes nothing when no issue is before the cut-off date", async () => {
  const sha = await repository("acme/api", { "README.md": "# API\n" })
  await repository("evals/v0-demo-context", { ".ctxpipe": "format: 3\n" })
  const context = join(base, "evals", "v0-demo-context.git")
  const before = git(context, "rev-parse", "main")
  server.use(
    http.get(`${API}/repos/acme/api`, () =>
      HttpResponse.json({ private: false, visibility: "public" }),
    ),
    http.get(`${API}/repos/acme/api/issues`, () => HttpResponse.json([])),
  )

  const counts = await importCorpusIssues(plan(sha, 5), access(), quiet)

  expect(counts).toEqual([{ corpus: "demo", source: "acme/api", issues: 0 }])
  expect(git(context, "rev-parse", "main")).toBe(before)
})

it("refuses a plan with two repositories of the same name", () => {
  const sha = "a".repeat(40)
  const clash = plan(sha)
  clash.corpora[0]?.repositories.push({ source: "other/api", sha, issues: 0 })
  expect(() => planSchema.parse(clash)).toThrow(
    "Two repositories of the plan are named v0-demo-api.",
  )
})
