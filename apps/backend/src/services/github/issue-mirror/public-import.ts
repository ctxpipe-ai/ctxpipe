import type { Octokit } from "octokit"

import {
  actorFromGraphql,
  type GithubMirrorFile,
  splitRepository,
} from "../github-mirror.js"
import type { GithubIssueSnapshot } from "./client.js"
import { renderGithubIssue } from "./converter.js"

type Rest = Octokit["rest"]["issues"]
type RestIssue = Awaited<ReturnType<Rest["get"]>>["data"]
type RestComment = Awaited<ReturnType<Rest["listComments"]>>["data"][number]
type RestEvent = Awaited<ReturnType<Rest["listEvents"]>>["data"][number]
type RestUser = RestIssue["user"]

/** REST and GraphQL both give `type` `User`, `Bot` or `Organization`. */
function actor(user: RestUser) {
  return actorFromGraphql(user && { login: user.login, __typename: user.type })
}

/** A GitHub timestamp, which has no milliseconds. */
function githubTime(time: number): string {
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z")
}

/** The fields that the issue events can change, as they were at `until`. */
function stateAt(issue: RestIssue, events: RestEvent[], until: number) {
  const labels = new Set(
    issue.labels.flatMap((label) =>
      typeof label === "string" ? [label] : label.name ? [label.name] : [],
    ),
  )
  const assignees = new Set((issue.assignees ?? []).map((user) => user.login))
  let title = issue.title
  // Undo each change after `until`, newest first.
  const later = events.filter((event) => Date.parse(event.created_at) > until)
  for (const event of later.reverse()) {
    const label = "label" in event ? event.label?.name : undefined
    const assignee = "assignee" in event ? event.assignee?.login : undefined
    if (event.event === "labeled" && label) labels.delete(label)
    if (event.event === "unlabeled" && label) labels.add(label)
    if (event.event === "assigned" && assignee) assignees.delete(assignee)
    if (event.event === "unassigned" && assignee) assignees.add(assignee)
    if (event.event === "renamed" && "rename" in event)
      title = event.rename.from
  }
  if (events.length === 0)
    return {
      title,
      labels: [...labels],
      assignees: [...assignees],
      closedAt: issue.closed_at,
      stateReason: issue.state_reason ?? null,
    }
  // The last close or reopen up to `until` gives the state.
  const lastClose = events
    .filter(
      (event) =>
        (event.event === "closed" || event.event === "reopened") &&
        Date.parse(event.created_at) <= until,
    )
    .at(-1)
  const closedAt = lastClose?.event === "closed" ? lastClose.created_at : null
  return {
    title,
    labels: [...labels],
    assignees: [...assignees],
    closedAt,
    // GitHub gives the reason of the current close only.
    stateReason:
      closedAt !== null && closedAt === issue.closed_at
        ? (issue.state_reason ?? null)
        : null,
  }
}

/**
 * The issue as the production mirror shows it, but as it was at `until`.
 * The events give the state, the title, the labels and the assignees at
 * `until`. Comments after `until` are not there. The body and the text of
 * each comment are the current text, because the REST API does not give
 * their edit history.
 *
 * `closedBy` is empty. Only GraphQL gives the closing pull requests, and
 * GraphQL needs a token. The eval corpora do not mirror pull requests.
 */
function snapshotAt(
  repository: string,
  issue: RestIssue,
  history: { comments: RestComment[]; events: RestEvent[] },
  until: number,
): GithubIssueSnapshot {
  const state = stateAt(issue, history.events, until)
  const kept = history.comments.filter(
    (comment) => Date.parse(comment.created_at) <= until,
  )
  return {
    id: issue.node_id,
    number: issue.number,
    repository,
    url: issue.html_url,
    title: state.title,
    body: issue.body ?? "",
    state: state.closedAt ? "closed" : "open",
    stateReason: state.stateReason,
    author: actor(issue.user),
    labels: state.labels,
    assignees: state.assignees,
    createdAt: issue.created_at,
    updatedAt:
      Date.parse(issue.updated_at) > until
        ? githubTime(until)
        : issue.updated_at,
    closedAt: state.closedAt,
    // The production mirror keeps the 100 most recent comments.
    comments: kept.slice(-100).map((comment) => ({
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
 * each issue with the production converter. It takes at most `limit` issues
 * created up to `until`. Pull requests are not issues and are skipped. A
 * repository that is not public is refused, also when the token can read
 * it, because the corpora are public.
 */
export async function* importPublicGithubIssues(input: {
  octokit: Octokit
  repository: string
  until: Date
  limit?: number
}): AsyncGenerator<GithubMirrorFile> {
  const { owner, repo } = splitRepository(input.repository)
  const { data: repository } = await input.octokit.rest.repos.get({
    owner,
    repo,
  })
  if (repository.private || repository.visibility !== "public")
    throw new Error(`${input.repository} is not a public repository`)
  const until = input.until.getTime()
  const limit = input.limit ?? Number.POSITIVE_INFINITY
  let count = 0
  const pages = input.octokit.paginate.iterator(
    input.octokit.rest.issues.listForRepo,
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
    for (const issue of page.data) {
      if (count >= limit) return
      if (issue.pull_request || Date.parse(issue.created_at) > until) continue
      const target = { owner, repo, issue_number: issue.number, per_page: 100 }
      const comments =
        issue.comments > 0
          ? await input.octokit.paginate(
              input.octokit.rest.issues.listComments,
              target,
            )
          : []
      // An issue with no change after `until` needs no history.
      const events =
        Date.parse(issue.updated_at) > until
          ? await input.octokit.paginate(
              input.octokit.rest.issues.listEvents,
              target,
            )
          : []
      count += 1
      yield renderGithubIssue(
        snapshotAt(input.repository, issue, { comments, events }, until),
      )
    }
  }
}
