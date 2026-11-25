import type { Octokit } from "octokit"

import {
  aliasActor,
  type GithubMirrorFile,
  githubTime,
  publicRepository,
  splitRepository,
} from "../github-mirror.js"
import { undoLaterEvents } from "../issue-mirror/public-import.js"
import { fetchPullRequestsByNumber } from "./client.js"
import { renderGithubPullRequest } from "./converter.js"
import { shouldMirrorGithubPullRequest } from "./policy.js"
import type { GithubPullRequestSnapshot } from "./types.js"

/**
 * The pull request mirror files of a public repository, for an eval corpus
 * (ADR-069, CTX-1661). It takes at most `limit` pull requests, newest first,
 * that the production mirror shows at `until` (`policy.ts`): closed up to
 * `until` and not a draft. A pull request that was open at `until` is left
 * out on purpose, because the production mirror does not show an open one,
 * and the twin must hold what production holds at `until`. Each is
 * rendered with the production converter, as it was at `until`: the issue
 * events give the title, the labels and the requested reviewers, and the
 * reviews and comments after `until` and the comments of a pending review
 * are not there. The body is the current one, because the API does not give its
 * history (`bodiesEditedAfter` finds the edited ones). GraphQL needs a
 * token, so `octokit` must have one. With `alias`, each person's login
 * becomes `alias(login)`.
 */
export async function* importPublicGithubPullRequests(input: {
  octokit: Octokit
  repository: string
  until: Date
  limit: number
  alias?: (login: string) => string
}): AsyncGenerator<GithubMirrorFile & { number: number }> {
  const { owner, repo } = await publicRepository(
    input.octokit,
    input.repository,
  )
  const until = input.until.getTime()
  const before = (time: string | null | undefined) => atOrBefore(time, until)
  let count = 0
  const pages = input.octokit.paginate.iterator(input.octokit.rest.pulls.list, {
    owner,
    repo,
    state: "closed",
    sort: "created",
    direction: "desc",
    per_page: 100,
  })
  for await (const page of pages) {
    const numbers = page.data
      .filter(
        (pull) =>
          before(pull.created_at) &&
          before(pull.closed_at) &&
          shouldMirrorGithubPullRequest({
            state: "closed",
            draft: pull.draft === true,
          }),
      )
      .map((pull) => pull.number)
      .slice(0, input.limit - count)
    // Small batches keep each GraphQL request under the node limit.
    for (let start = 0; start < numbers.length; start += 10) {
      const batch = { octokit: input.octokit, owner, repo }
      const snapshots = await fetchPullRequestsByNumber({
        ...batch,
        numbers: numbers.slice(start, start + 10),
      })
      const pending = await pendingCommentIds({
        ...batch,
        numbers: numbers.slice(start, start + 10),
      })
      for (const snapshot of snapshots.sort((a, b) => b.number - a.number)) {
        count += 1
        const atUntil = await snapshotAt(
          input.octokit,
          {
            ...snapshot,
            comments: snapshot.comments.filter(
              (comment) => !pending.has(comment.id),
            ),
          },
          until,
        )
        const alias = input.alias
        yield {
          ...renderGithubPullRequest(
            alias
              ? {
                  ...atUntil,
                  author: aliasActor(atUntil.author, alias),
                  requestedReviewers: atUntil.requestedReviewers.map(alias),
                  reviews: atUntil.reviews.map((review) => ({
                    ...review,
                    author: aliasActor(review.author, alias),
                  })),
                  comments: atUntil.comments.map((comment) => ({
                    ...comment,
                    author: aliasActor(comment.author, alias),
                  })),
                }
              : atUntil,
          ),
          number: snapshot.number,
        }
      }
    }
    if (count >= input.limit) return
  }
}

/**
 * The ids of the review comments of a pending review. GitHub shows a
 * pending review only to its author, the owner of the token. Such a draft
 * was never public, so it is not in the twin.
 */
async function pendingCommentIds(input: {
  octokit: Octokit
  owner: string
  repo: string
  numbers: number[]
}): Promise<Set<number>> {
  if (input.numbers.length === 0) return new Set()
  const data = await input.octokit.graphql<{
    repository: Record<
      string,
      {
        reviews: {
          nodes: Array<{
            comments: { nodes: Array<{ databaseId: number | null }> }
          }>
        }
      } | null
    > | null
  }>(
    `query PendingComments($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        ${input.numbers.map((number) => `p${number}: pullRequest(number: ${number}) { reviews(states: [PENDING], first: 10) { nodes { comments(first: 100) { nodes { databaseId } } } } }`).join("\n")}
      }
    }`,
    { owner: input.owner, repo: input.repo },
  )
  return new Set(
    Object.values(data.repository ?? {}).flatMap((pull) =>
      (pull?.reviews.nodes ?? []).flatMap((review) =>
        review.comments.nodes.flatMap((comment) =>
          comment.databaseId === null ? [] : [comment.databaseId],
        ),
      ),
    ),
  )
}

/** True when `time` is a time at or before `until`. */
function atOrBefore(time: string | null | undefined, until: number): boolean {
  return !!time && Date.parse(time) <= until
}

/** The pull request as it was at `until`. */
async function snapshotAt(
  octokit: Octokit,
  snapshot: GithubPullRequestSnapshot,
  until: number,
): Promise<GithubPullRequestSnapshot> {
  const before = (time: string | null) => atOrBefore(time, until)
  const kept = {
    ...snapshot,
    reviews: snapshot.reviews.filter((review) => before(review.submittedAt)),
    comments: snapshot.comments.filter((comment) => before(comment.createdAt)),
  }
  // A pull request with no change after `until` needs no history.
  if (before(snapshot.updatedAt)) return kept
  const { owner, repo } = splitRepository(snapshot.repository)
  const events = await octokit.paginate(octokit.rest.issues.listEvents, {
    owner,
    repo,
    issue_number: snapshot.number,
    per_page: 100,
  })
  const labels = new Set(snapshot.labels)
  const reviewers = new Set(snapshot.requestedReviewers)
  const title = undoLaterEvents(
    { title: snapshot.title, labels, assignees: new Set(), reviewers },
    events,
    until,
  )
  return {
    ...kept,
    title,
    labels: [...labels],
    requestedReviewers: [...reviewers],
    updatedAt: githubTime(until),
  }
}
