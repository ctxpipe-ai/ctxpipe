import type { Octokit } from "octokit"

import { type GithubMirrorFile, splitRepository } from "../github-mirror.js"
import { fetchPullRequestsByNumber } from "./client.js"
import { renderGithubPullRequest } from "./converter.js"
import { shouldMirrorGithubPullRequest } from "./policy.js"

/** A GitHub timestamp, which has no milliseconds. */
function githubTime(time: number): string {
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z")
}

/**
 * The pull request mirror files of a public repository, for an eval corpus
 * (ADR-069, CTX-1661). It takes at most `limit` pull requests, newest first,
 * that the production mirror shows at `until`: closed up to `until` and not
 * a draft. Each is rendered with the production converter. The reviews and
 * comments after `until` are not there. The body, the labels and the
 * requested reviewers are the current ones, because the API does not give
 * their history. GraphQL needs a token, so `octokit` must have one.
 */
export async function* importPublicGithubPullRequests(input: {
  octokit: Octokit
  repository: string
  until: Date
  limit: number
}): AsyncGenerator<GithubMirrorFile> {
  const { owner, repo } = splitRepository(input.repository)
  const { data: repository } = await input.octokit.rest.repos.get({
    owner,
    repo,
  })
  if (repository.private || repository.visibility !== "public")
    throw new Error(`${input.repository} is not a public repository`)
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
        yield renderGithubPullRequest({
          ...snapshot,
          updatedAt: before(snapshot.updatedAt)
            ? snapshot.updatedAt
            : githubTime(until),
          reviews: snapshot.reviews.filter((review) =>
            before(review.submittedAt),
          ),
          comments: snapshot.comments.filter((comment) =>
            before(comment.createdAt),
          ),
        })
      }
    }
    if (count >= input.limit) return
  }
}

/**
 * The numbers of the issues and pull requests whose body was edited after
 * `until`. Their mirror file shows the current body, which can hold later
 * facts, so the corpus records them. One GraphQL request for each 100.
 */
export async function bodiesEditedAfter(input: {
  octokit: Octokit
  repository: string
  numbers: number[]
  until: Date
}): Promise<number[]> {
  const { owner, repo } = splitRepository(input.repository)
  const until = input.until.getTime()
  const edited: number[] = []
  for (let start = 0; start < input.numbers.length; start += 100) {
    const numbers = input.numbers.slice(start, start + 100)
    const data = await input.octokit.graphql<{
      repository: Record<string, { lastEditedAt: string | null } | null> | null
    }>(
      `query BodiesEdited($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          ${numbers.map((number) => `n${number}: issueOrPullRequest(number: ${number}) { ... on Issue { lastEditedAt } ... on PullRequest { lastEditedAt } }`).join("\n")}
        }
      }`,
      { owner, repo },
    )
    for (const number of numbers) {
      const time = data.repository?.[`n${number}`]?.lastEditedAt
      if (time && Date.parse(time) > until) edited.push(number)
    }
  }
  return edited.sort((a, b) => a - b)
}
