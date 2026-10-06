import type { GithubPrActor } from "../pull-request-mirror/types.js"

/** `octokit.graphql`: the response is typed by the query it sends. */
export type GithubGraphql = <T>(
  query: string,
  variables: Record<string, unknown>,
) => Promise<T>

export type GithubIssueComment = {
  author: GithubPrActor
  body: string
  createdAt: string
}

export type GithubIssueSnapshot = {
  id: string
  number: number
  repository: string
  url: string
  title: string
  body: string
  state: "open" | "closed"
  stateReason: string | null
  author: GithubPrActor
  labels: string[]
  assignees: string[]
  createdAt: string
  updatedAt: string
  closedAt: string | null
  comments: GithubIssueComment[]
  /** URLs of the pull requests GitHub links as closing this issue. */
  closedBy: string[]
}

const COMMENTS = `
  pageInfo { hasNextPage endCursor }
  nodes { author { login __typename } body createdAt }
`

const ISSUE_FIELDS = `
  id number url title body state stateReason createdAt updatedAt closedAt
  author { login __typename }
  labels(first: 50) { nodes { name } }
  assignees(first: 20) { nodes { login } }
  comments(first: 100) { ${COMMENTS} }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { url } }
`

const ISSUE_PAGE_QUERY = `
  query GithubIssuePage($owner: String!, $repo: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      issues(first: $first, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes { ${ISSUE_FIELDS} }
      }
    }
  }
`

const ISSUE_QUERY = `
  query GithubIssue($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) { ${ISSUE_FIELDS} }
    }
  }
`

const ISSUE_COMMENTS_QUERY = `
  query GithubIssueComments($owner: String!, $repo: String!, $number: Int!, $after: String!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) { comments(first: 100, after: $after) { ${COMMENTS} } }
    }
  }
`

type Connection<T> = {
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
  nodes: T[]
}

type ActorNode = { login: string; __typename: string } | null

type CommentNode = { author: ActorNode; body: string; createdAt: string }

type IssueNode = {
  id: string
  number: number
  url: string
  title: string
  body: string
  state: "OPEN" | "CLOSED"
  stateReason: string | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
  author: ActorNode
  labels: { nodes: Array<{ name: string }> } | null
  assignees: { nodes: Array<{ login: string }> }
  comments: Connection<CommentNode>
  closedByPullRequestsReferences: {
    nodes: Array<{ url: string } | null>
  } | null
}

function splitRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo] = repository.split("/")
  if (!owner || !repo)
    throw new Error(`Invalid repository name "${repository}"`)
  return { owner, repo }
}

/**
 * A closing pull request in a repository the App cannot read comes back as a
 * null node with a FORBIDDEN error under that field; keep the rest.
 */
async function query<T>(
  graphql: GithubGraphql,
  text: string,
  variables: Record<string, unknown>,
): Promise<T> {
  try {
    return await graphql<T>(text, variables)
  } catch (error) {
    const { data, errors } = (error ?? {}) as {
      data?: T
      errors?: Array<{ type?: string; path?: unknown[] }>
    }
    const onlyClosingLinks = errors?.every(
      (entry) =>
        entry.type === "FORBIDDEN" &&
        entry.path?.includes("closedByPullRequestsReferences"),
    )
    if (data && onlyClosingLinks) return data
    throw error
  }
}

function nextCursor(connection: Connection<unknown>): string | null {
  return connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null
}

function actor(node: ActorNode): GithubPrActor {
  // A deleted account shows as GitHub's "ghost" user.
  if (!node) return { login: "ghost", type: "human" }
  return {
    login: node.login,
    type: node.__typename === "Bot" ? "bot" : "human",
  }
}

function comment(node: CommentNode): GithubIssueComment {
  return {
    author: actor(node.author),
    body: node.body,
    createdAt: node.createdAt,
  }
}

/** The issue with every comment: one further request per 100 comments past the first 100. */
async function withAllComments(input: {
  graphql: GithubGraphql
  repository: string
  node: IssueNode
}): Promise<GithubIssueSnapshot> {
  const { node } = input
  const comments = node.comments.nodes.map(comment)
  let after = nextCursor(node.comments)
  while (after) {
    const data = await query<{
      repository: { issue: { comments: Connection<CommentNode> } }
    }>(input.graphql, ISSUE_COMMENTS_QUERY, {
      ...splitRepository(input.repository),
      number: node.number,
      after,
    })
    const page = data.repository.issue.comments
    comments.push(...page.nodes.map(comment))
    after = nextCursor(page)
  }
  return {
    id: node.id,
    number: node.number,
    repository: input.repository,
    url: node.url,
    title: node.title,
    body: node.body,
    state: node.state === "OPEN" ? "open" : "closed",
    stateReason: node.stateReason?.toLowerCase() ?? null,
    author: actor(node.author),
    labels: node.labels?.nodes.map((label) => label.name) ?? [],
    assignees: node.assignees.nodes.map((assignee) => assignee.login),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    closedAt: node.closedAt,
    comments,
    closedBy:
      node.closedByPullRequestsReferences?.nodes.flatMap((pull) =>
        pull ? [pull.url] : [],
      ) ?? [],
  }
}

/**
 * Up to `max` issues of one repository, open and closed, newest updated
 * first: one request per 50 issues with their first 100 comments inlined.
 */
export async function fetchGithubIssues(input: {
  graphql: GithubGraphql
  repository: string
  max: number
}): Promise<GithubIssueSnapshot[]> {
  const issues: GithubIssueSnapshot[] = []
  let after: string | null = null
  while (issues.length < input.max) {
    const data: { repository: { issues: Connection<IssueNode> } } = await query(
      input.graphql,
      ISSUE_PAGE_QUERY,
      {
        ...splitRepository(input.repository),
        first: Math.min(50, input.max - issues.length),
        after,
      },
    )
    const page = data.repository.issues
    for (const node of page.nodes) {
      issues.push(
        await withAllComments({
          graphql: input.graphql,
          repository: input.repository,
          node,
        }),
      )
    }
    after = nextCursor(page)
    if (!after) break
  }
  return issues
}

/** One issue: one request, plus one per further 100 comments. */
export async function fetchGithubIssue(input: {
  graphql: GithubGraphql
  repository: string
  number: number
}): Promise<GithubIssueSnapshot> {
  const data = await query<{ repository: { issue: IssueNode } }>(
    input.graphql,
    ISSUE_QUERY,
    { ...splitRepository(input.repository), number: input.number },
  )
  return withAllComments({
    graphql: input.graphql,
    repository: input.repository,
    node: data.repository.issue,
  })
}
