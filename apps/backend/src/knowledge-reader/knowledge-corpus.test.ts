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
  importCorpusMirrors,
  type Plan,
  planSchema,
  snapshotRepositories,
} from "../../evals/knowledge/corpus.js"
import { useMswServer } from "../../test/msw.js"
import { serveZulip, withFakeClock, zulipMessage } from "../../test/zulip.js"

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
    http.get(`${API}/repos/acme/api`, () =>
      HttpResponse.json({ private: false, visibility: "public" }),
    ),
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
        repositories: [{ source: "acme/api", sha, issues, pulls: 0 }],
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

describe("importCorpusMirrors and freezeCorpora", () => {
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
      // The body of issue 1 was edited after the cut-off date.
      http.post(`${API}/graphql`, () =>
        HttpResponse.json({
          data: {
            repository: { n1: { lastEditedAt: "2026-07-01T00:00:00Z" } },
          },
        }),
      ),
    )

    const counts = await importCorpusMirrors(plan(sha, 5), access(), quiet)

    expect(counts).toEqual({
      repositories: [
        {
          corpus: "demo",
          source: "acme/api",
          issues: 1,
          pulls: 0,
          editedAfterCutoff: [1],
        },
      ],
      chat: [],
    })
    const context = join(base, "evals", "v0-demo-context.git")
    const file = git(context, "show", "main:github/issues/acme/api/1.md")
    expect(file).toContain("# Problem")
    expect(file).toContain(
      "sources:\n  - sources/github/evals/v0-demo-api.md\n---",
    )
    // The login of each person is a pseudonym.
    expect(file).toContain("author: person-0001")
    expect(file).not.toContain("bob")
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
            root: "",
          },
          workspace: "demo-v0",
        },
      ],
    })
  })
})

it("writes the pull requests closed before the cut-off date and the chat as they were then", async () => {
  const sha = await repository("acme/api", { "README.md": "# API\n" })
  await repository("evals/v0-demo-context", { ".ctxpipe": "format: 3\n" })
  const pull = (number: number, created: string, closed: string | null) => ({
    number,
    created_at: created,
    closed_at: closed,
    draft: false,
  })
  const connection = <T>(nodes: T[]) => ({
    pageInfo: { hasNextPage: false },
    nodes,
  })
  server.use(
    http.get(`${API}/repos/acme/api`, () =>
      HttpResponse.json({ private: false, visibility: "public" }),
    ),
    http.get(`${API}/repos/acme/api/pulls`, () =>
      HttpResponse.json([
        pull(9, "2026-06-05T00:00:00Z", "2026-06-06T00:00:00Z"),
        // Open at the cut-off date, so the mirror does not show it.
        pull(8, "2026-05-01T00:00:00Z", "2026-06-02T00:00:00Z"),
        pull(7, "2026-05-01T00:00:00Z", "2026-05-02T00:00:00Z"),
        {
          ...pull(6, "2026-05-01T00:00:00Z", "2026-05-02T00:00:00Z"),
          draft: true,
        },
      ]),
    ),
    http.post(`${API}/graphql`, async ({ request }) => {
      const { query } = (await request.json()) as { query: string }
      if (query.includes("BodiesEdited"))
        return HttpResponse.json({
          data: { repository: { n7: { lastEditedAt: null } } },
        })
      // The token owner's draft review holds comment 3.
      if (query.includes("PendingComments"))
        return HttpResponse.json({
          data: {
            repository: {
              p7: {
                reviews: connection([
                  { comments: connection([{ databaseId: 3 }]) },
                ]),
              },
            },
          },
        })
      expect(query).toContain("pr7: pullRequest(number: 7)")
      expect(query).not.toContain("pr8:")
      return HttpResponse.json({
        data: {
          repository: {
            pr7: {
              databaseId: 700,
              number: 7,
              url: "https://github.com/acme/api/pull/7",
              title: "Add typing events",
              body: "Adds the events. Asked Ada Quill in the chat.",
              state: "MERGED",
              merged: true,
              isDraft: false,
              author: { login: "bob", __typename: "User" },
              baseRefName: "main",
              baseRefOid: "a".repeat(40),
              headRefName: "typing",
              headRefOid: "b".repeat(40),
              createdAt: "2026-05-01T00:00:00Z",
              updatedAt: "2026-07-01T00:00:00Z",
              mergedAt: "2026-05-02T00:00:00Z",
              labels: connection([{ name: "api" }, { name: "later" }]),
              reviewRequests: connection([]),
              files: connection([{ path: "api.ts", changeType: "MODIFIED" }]),
              reviews: connection([]),
              comments: connection([
                {
                  databaseId: 1,
                  author: { login: "eve", __typename: "User" },
                  body: "Thanks, merged.",
                  createdAt: "2026-05-02T00:00:00Z",
                },
                {
                  databaseId: 2,
                  author: { login: "eve", __typename: "User" },
                  body: "This broke later.",
                  createdAt: "2026-07-01T00:00:00Z",
                },
              ]),
              reviewThreads: connection([
                {
                  comments: connection([
                    {
                      databaseId: 3,
                      author: { login: "eve", __typename: "User" },
                      body: "Draft note.",
                      createdAt: "2026-05-02T00:00:00Z",
                      path: "api.ts",
                      line: 1,
                    },
                  ]),
                },
              ]),
            },
          },
        },
      })
    }),
  )
  server.use(
    // After the cut-off date, the pull request got a label and a new title.
    http.get(`${API}/repos/acme/api/issues/7/events`, () =>
      HttpResponse.json([
        {
          event: "labeled",
          label: { name: "later" },
          created_at: "2026-07-01T00:00:00Z",
        },
        {
          event: "renamed",
          rename: { from: "Add typing", to: "Add typing events" },
          created_at: "2026-07-01T00:00:00Z",
        },
      ]),
    ),
  )
  serveZulip(server, "https://chat.example.test", [
    zulipMessage(1, "2026-05-20T00:00:00Z", { content: "Ship it, bob?" }),
    zulipMessage(2, "2026-06-20T00:00:00Z", { content: "Later." }),
  ])
  const withPulls = plan(sha)
  const corpus = withPulls.corpora[0]
  if (!corpus) throw new Error("no corpus")
  corpus.repositories[0] = { source: "acme/api", sha, issues: 0, pulls: 5 }
  corpus.chat = {
    realm: "https://chat.example.test",
    since: "2026-05-01T00:00:00Z",
    channels: [7],
  }

  const counts = await withFakeClock(() =>
    importCorpusMirrors(withPulls, access(), quiet),
  )

  expect(counts.repositories).toEqual([
    {
      corpus: "demo",
      source: "acme/api",
      issues: 0,
      pulls: 1,
      editedAfterCutoff: [],
    },
  ])
  // bob and eve of GitHub, then the author of the chat.
  expect(counts.chat[0]).toMatchObject({ topics: 1, messages: 1, people: 3 })
  const context = join(base, "evals", "v0-demo-context.git")
  expect(
    git(context, "ls-tree", "-r", "--name-only", "main").split("\n"),
  ).toEqual([
    ".ctxpipe",
    "chat/zulip/7/1.md",
    "github/pulls/acme/api/7--700.md",
  ])
  const file = git(context, "show", "main:github/pulls/acme/api/7--700.md")
  // The title and labels at the cut-off date, and no later comment.
  expect(file).toContain("# Add typing\n")
  expect(file).toContain("labels:\n  - api\n")
  expect(file).not.toContain("later")
  expect(file).toContain("Thanks, merged.")
  expect(file).not.toContain("This broke later.")
  expect(file).not.toContain("Draft note.")
  expect(file).toContain("updatedAt: 2026-06-01T00:00:00Z")
  expect(file).toContain("  - sources/github/evals/v0-demo-api.md")
  // Each login and the chat names are pseudonyms.
  expect(file).toContain("author: person-0001")
  expect(file).toContain("Asked person-0003 in the chat.")
  for (const secret of [/\bbob\b/, /\beve\b/, /Ada/, /Quill/])
    expect(file).not.toMatch(secret)
  const chat = git(context, "show", "main:chat/zulip/7/1.md")
  expect(chat).toContain(
    "### person-0003 · 2026-05-20T00:00:00Z\n\nShip it, person-0001?",
  )
  expect(chat).not.toContain("Later.")
})

it.each(["corpora-v0.plan.json", "orgbench-zulip-v1.plan.json"])(
  "the committed plan %s is valid",
  (name) => {
    const file = new URL(
      `../../evals/knowledge/fixtures/${name}`,
      import.meta.url,
    )
    expect(() =>
      planSchema.parse(JSON.parse(readFileSync(file, "utf8"))),
    ).not.toThrow()
  },
)

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

  const counts = await importCorpusMirrors(plan(sha, 5), access(), quiet)

  expect(counts.repositories).toEqual([
    {
      corpus: "demo",
      source: "acme/api",
      issues: 0,
      pulls: 0,
      editedAfterCutoff: [],
    },
  ])
  expect(git(context, "rev-parse", "main")).toBe(before)
})

it("refuses a plan with two repositories of the same name", () => {
  const sha = "a".repeat(40)
  const clash = plan(sha)
  clash.corpora[0]?.repositories.push({
    source: "other/api",
    sha,
    issues: 0,
    pulls: 0,
  })
  expect(() => planSchema.parse(clash)).toThrow(
    "Two repositories of the plan are named v0-demo-api.",
  )
})

it("refuses to snapshot a repository that is not public", async () => {
  const sha = await repository("acme/api", { "README.md": "# API\n" })
  const created = serveOrg()
  server.use(
    http.get(`${API}/repos/acme/api`, () =>
      HttpResponse.json({ private: true, visibility: "private" }),
    ),
  )

  await expect(
    snapshotRepositories(plan(sha), access(), quiet),
  ).rejects.toThrow("acme/api is not a public repository")
  expect(created).toEqual([])
})
