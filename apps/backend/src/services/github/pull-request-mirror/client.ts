import type { GithubPrActor, GithubPullRequestSnapshot } from "./types.js"
import { GITHUB_PR_FILE_STATUSES } from "./types.js"

type RestClient = {
  rest: {
    pulls: {
      get: (params: {
        owner: string
        repo: string
        pull_number: number
      }) => Promise<{ data: Record<string, unknown> }>
      listFiles: (params: {
        owner: string
        repo: string
        pull_number: number
        per_page: number
        page: number
      }) => Promise<{ data: Array<Record<string, unknown>> }>
      listReviews: (params: {
        owner: string
        repo: string
        pull_number: number
        per_page: number
        page: number
      }) => Promise<{ data: Array<Record<string, unknown>> }>
      listReviewComments: (params: {
        owner: string
        repo: string
        pull_number: number
        per_page: number
        page: number
      }) => Promise<{ data: Array<Record<string, unknown>> }>
      list: (params: {
        owner: string
        repo: string
        state: "closed" | "open" | "all"
        sort: "updated"
        direction: "desc"
        per_page: number
        page: number
      }) => Promise<{ data: Array<Record<string, unknown>> }>
    }
    issues: {
      listComments: (params: {
        owner: string
        repo: string
        issue_number: number
        per_page: number
        page: number
      }) => Promise<{ data: Array<Record<string, unknown>> }>
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function actorFromUser(value: unknown): GithubPrActor {
  const user = asRecord(value)
  const login = asString(user?.login) ?? "unknown"
  return {
    login,
    type: user?.type === "Bot" ? "bot" : "human",
  }
}

async function paginate<T extends Record<string, unknown>>(
  fetchPage: (page: number) => Promise<T[]>,
): Promise<T[]> {
  const all: T[] = []
  for (let page = 1; page <= 20; page += 1) {
    const batch = await fetchPage(page)
    all.push(...batch)
    if (batch.length < 100) break
  }
  return all
}

function parseFileStatus(value: unknown) {
  const status = asString(value)
  if (
    status &&
    GITHUB_PR_FILE_STATUSES.includes(
      status as (typeof GITHUB_PR_FILE_STATUSES)[number],
    )
  ) {
    return status as (typeof GITHUB_PR_FILE_STATUSES)[number]
  }
  return "modified" as const
}

export async function fetchGithubPullRequestSnapshot(input: {
  octokit: RestClient
  owner: string
  repo: string
  number: number
}): Promise<GithubPullRequestSnapshot> {
  const { data } = await input.octokit.rest.pulls.get({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.number,
  })
  const [files, reviews, reviewComments, issueComments] = await Promise.all([
    paginate((page) =>
      input.octokit.rest.pulls
        .listFiles({
          owner: input.owner,
          repo: input.repo,
          pull_number: input.number,
          per_page: 100,
          page,
        })
        .then((response) => response.data),
    ),
    paginate((page) =>
      input.octokit.rest.pulls
        .listReviews({
          owner: input.owner,
          repo: input.repo,
          pull_number: input.number,
          per_page: 100,
          page,
        })
        .then((response) => response.data),
    ),
    paginate((page) =>
      input.octokit.rest.pulls
        .listReviewComments({
          owner: input.owner,
          repo: input.repo,
          pull_number: input.number,
          per_page: 100,
          page,
        })
        .then((response) => response.data),
    ),
    input.octokit.rest.issues
      .listComments({
        owner: input.owner,
        repo: input.repo,
        issue_number: input.number,
        per_page: 100,
        page: 1,
      })
      .then((response) => response.data)
      .catch(() => []),
  ])

  const moreIssueComments =
    issueComments.length === 100
      ? await paginate((page) =>
          page === 1
            ? Promise.resolve(issueComments)
            : input.octokit.rest.issues
                .listComments({
                  owner: input.owner,
                  repo: input.repo,
                  issue_number: input.number,
                  per_page: 100,
                  page,
                })
                .then((response) => response.data)
                .catch(() => []),
        )
      : issueComments

  const base = asRecord(data.base)
  const head = asRecord(data.head)
  const htmlUrl = asString(data.html_url)
  const title = asString(data.title)
  const number = typeof data.number === "number" ? data.number : input.number
  const id = typeof data.id === "number" ? data.id : number
  if (!htmlUrl || !title || !asString(base?.ref) || !asString(base?.sha)) {
    throw new Error(
      `GitHub pull request ${input.owner}/${input.repo}#${input.number} is incomplete`,
    )
  }

  const comments = [
    ...moreIssueComments.map((comment) => ({
      id: typeof comment.id === "number" ? comment.id : 0,
      kind: "conversation" as const,
      author: actorFromUser(comment.user),
      body: asString(comment.body) ?? "",
      createdAt: asString(comment.created_at) ?? "",
    })),
    ...reviewComments.map((comment) => ({
      id: typeof comment.id === "number" ? comment.id : 0,
      kind: "review" as const,
      author: actorFromUser(comment.user),
      body: asString(comment.body) ?? "",
      createdAt: asString(comment.created_at) ?? "",
      path: asString(comment.path) ?? undefined,
      line:
        typeof comment.line === "number"
          ? comment.line
          : typeof comment.original_line === "number"
            ? comment.original_line
            : null,
    })),
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt))

  return {
    id,
    number,
    repository: `${input.owner}/${input.repo}`,
    url: htmlUrl,
    title,
    body: asString(data.body) ?? "",
    state: data.state === "open" ? "open" : "closed",
    merged: data.merged === true,
    draft: data.draft === true,
    author: actorFromUser(data.user),
    base: {
      ref: asString(base?.ref) ?? "",
      sha: asString(base?.sha) ?? "",
    },
    head: {
      ref: asString(head?.ref) ?? "",
      sha: asString(head?.sha) ?? "",
    },
    reviewDecision: null,
    labels: Array.isArray(data.labels)
      ? data.labels.flatMap((label) => {
          const name = asString(asRecord(label)?.name)
          return name ? [name] : []
        })
      : [],
    requestedReviewers: Array.isArray(data.requested_reviewers)
      ? data.requested_reviewers.flatMap((reviewer) => {
          const login = asString(asRecord(reviewer)?.login)
          return login ? [login] : []
        })
      : [],
    createdAt: asString(data.created_at) ?? "",
    updatedAt: asString(data.updated_at) ?? "",
    mergedAt: asString(data.merged_at),
    files: files.flatMap((file) => {
      const path = asString(file.filename)
      if (!path) return []
      const previousPath = asString(file.previous_filename)
      return [
        {
          path,
          status: parseFileStatus(file.status),
          ...(previousPath ? { previousPath } : {}),
        },
      ]
    }),
    reviews: reviews.map((review) => ({
      id: typeof review.id === "number" ? review.id : 0,
      author: actorFromUser(review.user),
      state: asString(review.state) ?? "COMMENTED",
      body: asString(review.body) ?? "",
      submittedAt: asString(review.submitted_at),
    })),
    comments,
    requiredChecks: [],
  }
}

export async function listMergedPullRequestNumbers(input: {
  octokit: RestClient
  owner: string
  repo: string
  max: number
}): Promise<number[]> {
  const numbers: number[] = []
  for (let page = 1; page <= 10 && numbers.length < input.max; page += 1) {
    const { data } = await input.octokit.rest.pulls.list({
      owner: input.owner,
      repo: input.repo,
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: 100,
      page,
    })
    for (const pull of data) {
      if (pull.merged_at == null) continue
      if (typeof pull.number !== "number") continue
      numbers.push(pull.number)
      if (numbers.length >= input.max) break
    }
    if (data.length < 100) break
  }
  return numbers
}
