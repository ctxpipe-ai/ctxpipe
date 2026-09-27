import { describe, expect, it } from "vitest"
import {
  fetchGithubPullRequestSnapshot,
  listMergedPullRequestNumbers,
} from "./client.js"

function page<T>(items: T[], perPage: number, pageNumber: number): T[] {
  return items.slice((pageNumber - 1) * perPage, pageNumber * perPage)
}

function fakeOctokit(input: {
  files: number
  closed: Array<{ number: number; merged: boolean }>
}) {
  const files = Array.from({ length: input.files }, (_, i) => ({
    filename: `src/file-${i}.ts`,
    status: i % 3 === 0 ? "added" : "modified",
  }))
  const closed = input.closed.map((pull) => ({
    number: pull.number,
    merged_at: pull.merged ? "2026-03-02T00:00:00Z" : null,
  }))
  return {
    rest: {
      pulls: {
        get: async () => ({
          data: {
            id: 99,
            number: 8,
            html_url: "https://github.com/acme/api/pull/8",
            title: "Split",
            body: "Body",
            state: "closed",
            merged: true,
            draft: false,
            user: { login: "alice", type: "User" },
            base: { ref: "main", sha: "a" },
            head: { ref: "f", sha: "b" },
            labels: [{ name: "backend" }],
            requested_reviewers: [],
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-02T00:00:00Z",
            merged_at: "2026-03-02T00:00:00Z",
          },
        }),
        listFiles: async ({ page: p }: { page: number }) => ({
          data: page(files, 100, p),
        }),
        listReviews: async () => ({ data: [] }),
        listReviewComments: async () => ({ data: [] }),
        list: async ({ page: p }: { page: number }) => ({
          data: page(closed, 100, p),
        }),
      },
      issues: {
        listComments: async () => ({ data: [] }),
      },
    },
  }
}

describe("fetchGithubPullRequestSnapshot", () => {
  it("paginates changed files past one page and normalizes actors", async () => {
    const octokit = fakeOctokit({ files: 150, closed: [] })
    const snapshot = await fetchGithubPullRequestSnapshot({
      octokit,
      owner: "acme",
      repo: "api",
      number: 8,
    })
    expect(snapshot.files).toHaveLength(150)
    expect(snapshot.files[0]).toEqual({
      path: "src/file-0.ts",
      status: "added",
    })
    expect(snapshot.author).toEqual({ login: "alice", type: "human" })
    expect(snapshot.labels).toEqual(["backend"])
    expect(snapshot.merged).toBe(true)
  })
})

describe("listMergedPullRequestNumbers", () => {
  it("skips unmerged closed pull requests, pages, and respects max", async () => {
    const closed = Array.from({ length: 130 }, (_, i) => ({
      number: i + 1,
      merged: i % 2 === 0,
    }))
    const octokit = fakeOctokit({ files: 0, closed })
    const all = await listMergedPullRequestNumbers({
      octokit,
      owner: "acme",
      repo: "api",
      max: 1000,
    })
    expect(all).toHaveLength(65)
    expect(all.every((n) => n % 2 === 1)).toBe(true)
    const capped = await listMergedPullRequestNumbers({
      octokit,
      owner: "acme",
      repo: "api",
      max: 10,
    })
    expect(capped).toHaveLength(10)
  })
})
