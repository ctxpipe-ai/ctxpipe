import type { Octokit } from "octokit"

import {
  actorFromGraphql,
  type GithubMirrorFile,
  splitRepository,
} from "../github-mirror.js"
import type { GithubIssueSnapshot } from "./client.js"
import { renderGithubIssue } from "./converter.js"

/** The fields of a REST user that the mirror reads. */
type RestUser = { login: string; type: string } | null

type RestIssue = {
  node_id: string
  number: number
  html_url: string
  title: string
  body?: string | null
  state: string
  state_reason?: string | null
  user: RestUser
  labels: Array<string | { name?: string }>
  assignees?: Array<{ login: string }> | null
  comments: number
  created_at: string
  updated_at: string
  closed_at: string | null
  pull_request?: unknown
}

type RestComment = { user: RestUser; body?: string; created_at: string }

/** The production mirror keeps the 100 most recent comments of an issue. */
const MIRRORED_COMMENTS = 100

/** REST and GraphQL both give `type` `User`, `Bot` or `Organization`. */
function actor(user: RestUser) {
  return actorFromGraphql(user && { login: user.login, __typename: user.type })
}

/** A GitHub timestamp, which has no milliseconds. */
function githubTime(time: number): string {
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z")
}

/**
 * The issue as the production mirror shows it, but as it was at `until`:
 * comments after `until` are not there, and an issue closed after `until` is
 * open. The title, the body and the labels are the current ones, because
 * the REST API does not give their history.
 *
 * `closedBy` is empty. Only GraphQL gives the closing pull requests, and
 * GraphQL needs a token. The eval corpora do not mirror pull requests.
 */
function snapshotAt(
  repository: string,
  issue: RestIssue,
  comments: RestComment[],
  until: number,
): GithubIssueSnapshot {
  const closed =
    issue.closed_at !== null && Date.parse(issue.closed_at) <= until
  const kept = comments.filter(
    (comment) => Date.parse(comment.created_at) <= until,
  )
  return {
    id: issue.node_id,
    number: issue.number,
    repository,
    url: issue.html_url,
    title: issue.title,
    body: issue.body ?? "",
    state: closed ? "closed" : "open",
    stateReason: closed ? (issue.state_reason ?? null) : null,
    author: actor(issue.user),
    labels: issue.labels.flatMap((label) =>
      typeof label === "string" ? [label] : label.name ? [label.name] : [],
    ),
    assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
    createdAt: issue.created_at,
    updatedAt:
      Date.parse(issue.updated_at) > until
        ? githubTime(until)
        : issue.updated_at,
    closedAt: closed ? issue.closed_at : null,
    comments: kept.slice(-MIRRORED_COMMENTS).map((comment) => ({
      author: actor(comment.user),
      body: comment.body ?? "",
      createdAt: comment.created_at,
    })),
    commentsTotal: kept.length,
    closedBy: [],
  }
}

/**
 * The issue mirror files of a public repository, for an eval corpus
 * (ADR-069). It reads the public REST API, newest issue first, and renders
 * each issue with the production converter. It takes the issues created
 * from `since` to `until`, at most `limit` of them. Pull requests are not
 * issues and are skipped.
 */
export async function* importPublicGithubIssues(input: {
  octokit: Octokit
  repository: string
  until: Date
  since?: Date
  limit?: number
}): AsyncGenerator<GithubMirrorFile> {
  const { owner, repo } = splitRepository(input.repository)
  const until = input.until.getTime()
  const since = input.since?.getTime() ?? Number.NEGATIVE_INFINITY
  const limit = input.limit ?? Number.POSITIVE_INFINITY
  let count = 0
  const pages = input.octokit.paginate.iterator(
    "GET /repos/{owner}/{repo}/issues",
    {
      owner,
      repo,
      state: "all",
      sort: "created",
      direction: "desc",
      per_page: 100,
    },
  )
  for await (const page of pages) {
    for (const issue of page.data as RestIssue[]) {
      const created = Date.parse(issue.created_at)
      if (created < since || count >= limit) return
      if (issue.pull_request || created > until) continue
      const comments =
        issue.comments > 0
          ? ((await input.octokit.paginate(
              "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
              { owner, repo, issue_number: issue.number, per_page: 100 },
            )) as RestComment[])
          : []
      count += 1
      yield renderGithubIssue(
        snapshotAt(input.repository, issue, comments, until),
      )
    }
  }
}
