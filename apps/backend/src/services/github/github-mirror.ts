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
