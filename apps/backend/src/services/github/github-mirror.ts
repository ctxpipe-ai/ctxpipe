import type { Octokit } from "octokit"

/** A GitHub account as a mirror file shows it. */
export type GithubActor = {
  login: string
  type: "human" | "bot"
}

/** One file that a GitHub mirror writes into a Workspace. */
export type GithubMirrorFile = {
  path: string
  content: string
}

/** `owner/repo` in its two parts. */
export function splitRepository(repository: string): {
  owner: string
  repo: string
} {
  const [owner, repo] = repository.split("/")
  if (!owner || !repo)
    throw new Error(`Invalid repository name "${repository}"`)
  return { owner, repo }
}

export function actorLine(actor: GithubActor): string {
  return actor.type === "bot" ? `${actor.login} (bot)` : actor.login
}

/**
 * The actor with its login replaced by `alias(login)`, for the pseudonyms
 * of an eval twin (CTX-1661). A bot and a deleted account stay as they are.
 */
export function aliasActor(
  actor: GithubActor,
  alias: (login: string) => string,
): GithubActor {
  return actor.type === "bot" || actor.login === "unknown"
    ? actor
    : { ...actor, login: alias(actor.login) }
}

/**
 * The numbers of the issues and pull requests whose body was edited after
 * `until`, for an eval corpus (CTX-1661). Their mirror file shows the
 * current body, which can hold later facts. One GraphQL request for each
 * 100 numbers, so `octokit` must have a token.
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

export type GraphqlActor = { login?: string; __typename?: string } | null

/** A GraphQL `author`; a deleted account has none and shows as "unknown". */
export function actorFromGraphql(actor: GraphqlActor | undefined): GithubActor {
  const bot = actor?.__typename === "Bot"
  const login = actor?.login || "unknown"
  // REST names bot accounts `<app>[bot]`; keep text identical across reads.
  return {
    login: bot && !login.endsWith("[bot]") ? `${login}[bot]` : login,
    type: bot ? "bot" : "human",
  }
}
