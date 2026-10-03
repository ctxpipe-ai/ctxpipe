import type {
  GithubPrActor,
  GithubPrFileStatus,
  GithubPullRequestSnapshot,
} from "./types.js"
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

/** REST read of one pull request; only for what one GraphQL page cannot carry. */
async function fetchGithubPullRequestSnapshot(input: {
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

type GraphqlClient = {
  graphql: <T>(query: string, variables: Record<string, unknown>) => Promise<T>
}

export type GithubPrClient = RestClient & GraphqlClient

type Connection<T> = {
  pageInfo?: { hasNextPage?: boolean }
  nodes?: Array<T | null>
}

type GraphqlActor = { login?: string; __typename?: string } | null

type GraphqlComment = {
  databaseId?: number
  author?: GraphqlActor
  body?: string
  createdAt?: string
}

type GraphqlPullRequest = {
  databaseId?: number
  number?: number
  url?: string
  title?: string
  body?: string
  state?: string
  merged?: boolean
  isDraft?: boolean
  author?: GraphqlActor
  baseRefName?: string
  baseRefOid?: string
  headRefName?: string
  headRefOid?: string
  createdAt?: string
  updatedAt?: string
  mergedAt?: string | null
  labels?: Connection<{ name?: string }>
  reviewRequests?: Connection<{ requestedReviewer?: GraphqlActor }>
  files?: Connection<{ path?: string; changeType?: string }>
  reviews?: Connection<{
    databaseId?: number
    author?: GraphqlActor
    state?: string
    body?: string
    submittedAt?: string | null
  }>
  comments?: Connection<GraphqlComment>
  reviewThreads?: Connection<{
    comments?: Connection<
      GraphqlComment & {
        path?: string
        line?: number | null
        originalLine?: number | null
      }
    >
  }>
}

/**
 * Everything the mirror renders, inlined so one request returns a whole page.
 * Nested lists past these sizes, and renames (GraphQL omits the previous
 * path), fall back to the REST read for that pull request.
 */
const PULL_REQUEST_FIELDS = `
  databaseId number url title body state merged isDraft
  author { login __typename }
  baseRefName baseRefOid headRefName headRefOid
  createdAt updatedAt mergedAt
  labels(first: 100) { pageInfo { hasNextPage } nodes { name } }
  reviewRequests(first: 100) {
    pageInfo { hasNextPage }
    nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } } }
  }
  files(first: 100) { pageInfo { hasNextPage } nodes { path changeType } }
  reviews(first: 100) {
    pageInfo { hasNextPage }
    nodes { databaseId author { login __typename } state body submittedAt }
  }
  comments(first: 100) {
    pageInfo { hasNextPage }
    nodes { databaseId author { login __typename } body createdAt }
  }
  reviewThreads(first: 50) {
    pageInfo { hasNextPage }
    nodes {
      comments(first: 50) {
        pageInfo { hasNextPage }
        nodes { databaseId author { login __typename } body createdAt path line originalLine }
      }
    }
  }
`

function nodesOf<T>(connection: Connection<T> | undefined): T[] {
  return (connection?.nodes ?? []).filter((node): node is T => node != null)
}

function actorFromGraphql(actor: GraphqlActor | undefined): GithubPrActor {
  const bot = actor?.__typename === "Bot"
  const login = asString(actor?.login) ?? "unknown"
  // REST names bot accounts `<app>[bot]`; keep text identical across reads.
  return {
    login: bot && !login.endsWith("[bot]") ? `${login}[bot]` : login,
    type: bot ? "bot" : "human",
  }
}

const CHANGE_TYPES: Record<string, GithubPrFileStatus> = {
  ADDED: "added",
  DELETED: "removed",
  MODIFIED: "modified",
  RENAMED: "renamed",
  COPIED: "copied",
  CHANGED: "changed",
}

/** Null when the page cannot carry the pull request in full. */
function snapshotFromGraphql(
  pull: GraphqlPullRequest,
  repository: string,
): GithubPullRequestSnapshot | null {
  const threads = nodesOf(pull.reviewThreads)
  const files = nodesOf(pull.files)
  if (
    [
      pull.labels,
      pull.reviewRequests,
      pull.files,
      pull.reviews,
      pull.comments,
      pull.reviewThreads,
      ...threads.map((thread) => thread.comments),
    ].some((connection) => connection?.pageInfo?.hasNextPage) ||
    files.some(
      (file) => file.changeType === "RENAMED" || file.changeType === "COPIED",
    )
  )
    return null
  const number = pull.number ?? 0
  return {
    id: pull.databaseId ?? number,
    number,
    repository,
    url: pull.url ?? "",
    title: pull.title ?? "",
    body: pull.body ?? "",
    state: pull.state === "OPEN" ? "open" : "closed",
    merged: pull.merged === true,
    draft: pull.isDraft === true,
    author: actorFromGraphql(pull.author),
    base: { ref: pull.baseRefName ?? "", sha: pull.baseRefOid ?? "" },
    head: { ref: pull.headRefName ?? "", sha: pull.headRefOid ?? "" },
    reviewDecision: null,
    labels: nodesOf(pull.labels).flatMap((label) =>
      label.name ? [label.name] : [],
    ),
    requestedReviewers: nodesOf(pull.reviewRequests).flatMap((request) =>
      asString(request.requestedReviewer?.login)
        ? [actorFromGraphql(request.requestedReviewer).login]
        : [],
    ),
    createdAt: pull.createdAt ?? "",
    updatedAt: pull.updatedAt ?? "",
    mergedAt: asString(pull.mergedAt),
    files: files.flatMap((file) =>
      file.path
        ? [
            {
              path: file.path,
              status: CHANGE_TYPES[file.changeType ?? ""] ?? "modified",
            },
          ]
        : [],
    ),
    reviews: nodesOf(pull.reviews).map((review) => ({
      id: review.databaseId ?? 0,
      author: actorFromGraphql(review.author),
      state: review.state ?? "COMMENTED",
      body: review.body ?? "",
      submittedAt: asString(review.submittedAt),
    })),
    comments: [
      ...nodesOf(pull.comments).map((comment) => ({
        id: comment.databaseId ?? 0,
        kind: "conversation" as const,
        author: actorFromGraphql(comment.author),
        body: comment.body ?? "",
        createdAt: comment.createdAt ?? "",
      })),
      ...threads.flatMap((thread) =>
        nodesOf(thread.comments).map((comment) => ({
          id: comment.databaseId ?? 0,
          kind: "review" as const,
          author: actorFromGraphql(comment.author),
          body: comment.body ?? "",
          createdAt: comment.createdAt ?? "",
          path: comment.path ?? undefined,
          line: comment.line ?? comment.originalLine ?? null,
        })),
      ),
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    requiredChecks: [],
  }
}

async function completeSnapshots(input: {
  octokit: GithubPrClient
  owner: string
  repo: string
  pulls: GraphqlPullRequest[]
}): Promise<GithubPullRequestSnapshot[]> {
  const repository = `${input.owner}/${input.repo}`
  const snapshots: GithubPullRequestSnapshot[] = []
  for (const pull of input.pulls) {
    snapshots.push(
      snapshotFromGraphql(pull, repository) ??
        (await fetchGithubPullRequestSnapshot({
          octokit: input.octokit,
          owner: input.owner,
          repo: input.repo,
          number: pull.number ?? 0,
        })),
    )
  }
  return snapshots
}

/** One page of merged pull requests, most recently updated first, in one request. */
export async function fetchMergedPullRequestPage(input: {
  octokit: GithubPrClient
  owner: string
  repo: string
  first: number
  after: string | null
}): Promise<{
  snapshots: GithubPullRequestSnapshot[]
  nextAfter: string | null
}> {
  const data = await input.octokit.graphql<{
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
        nodes: Array<GraphqlPullRequest | null>
      }
    } | null
  }>(
    `query MergedPullRequests($owner: String!, $repo: String!, $first: Int!, $after: String) {
      repository(owner: $owner, name: $repo) {
        pullRequests(states: MERGED, orderBy: {field: UPDATED_AT, direction: DESC}, first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { ${PULL_REQUEST_FIELDS} }
        }
      }
    }`,
    {
      owner: input.owner,
      repo: input.repo,
      first: input.first,
      after: input.after,
    },
  )
  const connection = data.repository?.pullRequests
  return {
    snapshots: await completeSnapshots({
      ...input,
      pulls: nodesOf(connection),
    }),
    nextAfter: connection?.pageInfo.hasNextPage
      ? connection.pageInfo.endCursor
      : null,
  }
}

/** The named pull requests in one request, however many there are. */
export async function fetchPullRequestsByNumber(input: {
  octokit: GithubPrClient
  owner: string
  repo: string
  numbers: number[]
}): Promise<GithubPullRequestSnapshot[]> {
  const numbers = [...new Set(input.numbers)].filter(Number.isInteger)
  if (numbers.length === 0) return []
  const data = await input.octokit.graphql<{
    repository: Record<string, GraphqlPullRequest | null> | null
  }>(
    `query PullRequestsByNumber($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        ${numbers.map((number) => `pr${number}: pullRequest(number: ${number}) { ${PULL_REQUEST_FIELDS} }`).join("\n")}
      }
    }`,
    { owner: input.owner, repo: input.repo },
  )
  return completeSnapshots({
    ...input,
    pulls: numbers.flatMap((number) => {
      const pull = data.repository?.[`pr${number}`]
      return pull ? [pull] : []
    }),
  })
}
