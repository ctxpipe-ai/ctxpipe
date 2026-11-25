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
 * `until` and not a draft. Each is rendered with the production converter,
 * as it was at `until`: the issue events give the title, the labels and the
 * requested reviewers, and the reviews and comments after `until` are not
 * there. The body is the current one, because the API does not give its
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
  const before = (time: string | null | undefined) =>
    !!time && Date.parse(time) <= until
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
      const snapshots = await fetchPullRequestsByNumber({
        octokit: input.octokit,
        owner,
        repo,
        numbers: numbers.slice(start, start + 10),
      })
      for (const snapshot of snapshots.sort((a, b) => b.number - a.number)) {
        count += 1
        const atUntil = await snapshotAt(input.octokit, snapshot, until)
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

/** The pull request as it was at `until`. */
async function snapshotAt(
  octokit: Octokit,
  snapshot: GithubPullRequestSnapshot,
  until: number,
): Promise<GithubPullRequestSnapshot> {
  const before = (time: string | null) => !!time && Date.parse(time) <= until
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
