import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { repositories } from "../../db/schema/repositories.js"
import { bulkCreateRepositoriesForOrg } from "../../models/repositories.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { ensureOrgRepositoryForGitUrl } from "./ensure-org-repository.js"
import { repositoryKeyFromGitUrl } from "./slug.js"

type Fixture = Parameters<Parameters<typeof withNativeHydrationFixture>[1]>[0]

const installationId = 123456789
const otherInstallationId = 987654321

type GithubRepository = { id: number; fullName: string }

/**
 * GitHub's view of one installation. `mint` is the status of the
 * repository-scoped token request. `granted` lists the repositories that the
 * installation can read; GitHub resolves a token request by repository name
 * inside the installation's account. `lookups` maps a requested owner/name
 * (an old name included) to the repository that GitHub answers with.
 */
function githubInstallation(input: {
  installationId: number
  mint: 201 | 404 | 422 | 500
  granted?: GithubRepository[]
  lookups?: Record<string, GithubRepository>
}) {
  const token = `fixture-only-read-token-${input.installationId}`
  const granted = input.granted ?? []
  const lookups = input.lookups ?? {}
  const authorized = (request: Request) =>
    request.headers.get("authorization")?.endsWith(token) ?? false
  return [
    http.post(
      `https://api.github.com/app/installations/${input.installationId}/access_tokens`,
      async ({ request }) => {
        if (input.mint !== 201)
          return HttpResponse.json(
            { message: "GitHub answer" },
            { status: input.mint },
          )
        const body = (await request.json()) as { repositories?: string[] }
        const names = body.repositories ?? []
        const repositories = granted.filter((repository) =>
          names.includes(repository.fullName.split("/")[1] ?? ""),
        )
        if (repositories.length !== names.length)
          return HttpResponse.json(
            {
              message:
                "There is at least one repository that does not exist or is not accessible to the parent installation.",
            },
            { status: 422 },
          )
        return HttpResponse.json(
          {
            token,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            permissions: { contents: "read", metadata: "read" },
            repositories: repositories.map((repository) => ({
              id: repository.id,
              name: repository.fullName.split("/")[1],
              full_name: repository.fullName,
            })),
          },
          { status: 201 },
        )
      },
    ),
    http.get(
      "https://api.github.com/installation/repositories",
      ({ request }) => {
        if (!authorized(request)) return undefined
        return HttpResponse.json({
          total_count: granted.length,
          repositories: granted.map((repository) => ({
            id: repository.id,
            full_name: repository.fullName,
          })),
        })
      },
    ),
    http.get(
      "https://api.github.com/repos/:owner/:repo",
      ({ request, params }) => {
        if (!authorized(request)) return undefined
        const repository = lookups[`${params.owner}/${params.repo}`]
        return repository
          ? HttpResponse.json({
              id: repository.id,
              full_name: repository.fullName,
            })
          : HttpResponse.json({ message: "Not Found" }, { status: 404 })
      },
    ),
  ]
}

async function setAccountSlug(f: Fixture, accountSlug: string) {
  await withOrgDbContext(f.org.id, (db) =>
    db
      .update(connections)
      .set({
        config: {
          installationId,
          accountSlug,
          ingestAllRepositories: false,
          includeFutureRepos: false,
        },
      })
      .where(eq(connections.id, f.connectionId)),
  )
}

async function storedConfig(f: Fixture) {
  const [row] = await withOrgDbContext(f.org.id, (db) =>
    db
      .select({ config: connections.config })
      .from(connections)
      .where(eq(connections.id, f.connectionId)),
  )
  return row?.config
}

async function insertRepository(
  f: Fixture,
  id: string,
  gitUrl: string,
  githubConnectionId: string | null,
) {
  await withOrgDbContext(f.org.id, (db) =>
    db.insert(repositories).values({
      id,
      orgId: f.org.id,
      name: gitUrl.replace("https://github.com/", ""),
      gitUrl,
      repositoryKey: repositoryKeyFromGitUrl(gitUrl),
      githubConnectionId,
    }),
  )
}

function link(f: Fixture, gitUrl: string, githubConnectionId: string) {
  return withOrgIdContext(f.org, () =>
    ensureOrgRepositoryForGitUrl({
      orgId: f.org.id,
      gitUrl,
      githubConnectionId,
    }),
  )
}

async function bindingOf(f: Fixture, repositoryId: string | undefined) {
  const [row] = await withOrgDbContext(f.org.id, (db) =>
    db
      .select({ githubConnectionId: repositories.githubConnectionId })
      .from(repositories)
      .where(eq(repositories.id, repositoryId ?? "")),
  )
  return row?.githubConnectionId
}

it(
  "binds a linked repository to the connection when GitHub mints a read token for it",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      const own = { id: 101, fullName: "fixture/own-service" }
      f.server.use(
        ...githubInstallation({
          installationId,
          mint: 201,
          granted: [own],
          lookups: { [own.fullName]: own },
        }),
      )

      const linked = await link(
        f,
        "https://github.com/fixture/own-service",
        f.connectionId,
      )

      expect(linked?.created).toBe(true)
      expect(await bindingOf(f, linked?.id)).toBe(f.connectionId)
    })
  },
)

it(
  "does not bind a repository that a selected-repositories installation is not granted, and clears that stale binding",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      // The stored account equals the owner, but GitHub does not grant the repository.
      await setAccountSlug(f, "fixture")
      const staleId = `repo_${f.id}_stale`
      await insertRepository(
        f,
        staleId,
        "https://github.com/fixture/revoked-service",
        f.connectionId,
      )
      f.server.use(...githubInstallation({ installationId, mint: 422 }))

      const created = await link(
        f,
        "https://github.com/fixture/not-granted",
        f.connectionId,
      )
      await link(
        f,
        "https://github.com/fixture/revoked-service",
        f.connectionId,
      )

      expect(created?.created).toBe(true)
      expect(await bindingOf(f, created?.id)).toBeNull()
      expect(await bindingOf(f, staleId)).toBeNull()
    })
  },
)

it(
  "binds a repository of a renamed account when GitHub mints a read token for it",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      // The stored account is stale, and the URL still uses the old owner name.
      await setAccountSlug(f, "fixture")
      const before = await storedConfig(f)
      const renamed = { id: 202, fullName: "new-org-name/private-service" }
      f.server.use(
        ...githubInstallation({
          installationId,
          mint: 201,
          granted: [renamed],
          lookups: { "old-org-name/private-service": renamed },
        }),
      )

      const linked = await link(
        f,
        "https://github.com/old-org-name/private-service",
        f.connectionId,
      )

      expect(await bindingOf(f, linked?.id)).toBe(f.connectionId)
      expect(await storedConfig(f)).toEqual(before)
    })
  },
)

it(
  "does not bind another owner's repository that has the same name as a granted one",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      // GitHub resolves the token request by name in the installation's
      // account, so the mint succeeds for the fork, not for the upstream.
      const fork = { id: 303, fullName: "fixture/shared-name" }
      const upstream = { id: 304, fullName: "upstream/shared-name" }
      f.server.use(
        ...githubInstallation({
          installationId,
          mint: 201,
          granted: [fork],
          lookups: { [fork.fullName]: fork, [upstream.fullName]: upstream },
        }),
      )

      const linked = await link(
        f,
        "https://github.com/upstream/shared-name",
        f.connectionId,
      )

      expect(await bindingOf(f, linked?.id)).toBeNull()
    })
  },
)

it(
  "keeps a repository bound to the connection that covers it when another Workspace links it",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      const otherConnectionId = `con_${f.id}_other`
      await withOrgDbContext(f.org.id, (db) =>
        db.insert(connections).values({
          id: otherConnectionId,
          orgId: f.org.id,
          type: "github",
          config: {
            installationId: otherInstallationId,
            accountSlug: "other-account",
            ingestAllRepositories: false,
            includeFutureRepos: false,
          },
        }),
      )
      const privateId = `repo_${f.id}_private`
      await insertRepository(
        f,
        privateId,
        "https://github.com/fixture/private-service",
        f.connectionId,
      )
      f.server.use(
        ...githubInstallation({
          installationId: otherInstallationId,
          mint: 422,
        }),
      )

      await link(
        f,
        "https://github.com/fixture/private-service",
        otherConnectionId,
      )

      expect(await bindingOf(f, privateId)).toBe(f.connectionId)
    })
  },
)

it(
  "changes no binding when GitHub fails to answer the token request",
  // Octokit retries a 5xx with backoff before it fails.
  { timeout: 60_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      await setAccountSlug(f, "fixture")
      const before = await storedConfig(f)
      const boundId = `repo_${f.id}_bound`
      await insertRepository(
        f,
        boundId,
        "https://github.com/fixture/bound-service",
        f.connectionId,
      )
      f.server.use(...githubInstallation({ installationId, mint: 500 }))

      const bound = await link(
        f,
        "https://github.com/fixture/bound-service",
        f.connectionId,
      )

      expect(bound?.id).toBe(boundId)
      expect(await bindingOf(f, boundId)).toBe(f.connectionId)
      expect(await storedConfig(f)).toEqual(before)
    })
  },
)

it(
  "binds an unbound repository when the installation sync lists it, and keeps another connection's binding",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      const otherConnectionId = `con_${f.id}_other`
      await withOrgDbContext(f.org.id, (db) =>
        db.insert(connections).values({
          id: otherConnectionId,
          orgId: f.org.id,
          type: "github",
          config: {
            installationId: otherInstallationId,
            ingestAllRepositories: false,
            includeFutureRepos: false,
          },
        }),
      )
      const otherId = `repo_${f.id}_other`
      await insertRepository(
        f,
        otherId,
        "https://github.com/fixture/other-bound",
        otherConnectionId,
      )
      // A link before the installation was granted the repository leaves it unbound.
      f.server.use(...githubInstallation({ installationId, mint: 422 }))
      const linked = await link(
        f,
        "https://github.com/fixture/later-granted",
        f.connectionId,
      )
      expect(await bindingOf(f, linked?.id)).toBeNull()

      // The sync stores GitHub's clone URL, not the link's normalized URL.
      const created = await bulkCreateRepositoriesForOrg(
        f.org.id,
        [
          {
            name: "fixture/Later-Granted",
            gitUrl: "https://github.com/fixture/Later-Granted.git",
          },
          {
            name: "fixture/other-bound",
            gitUrl: "https://github.com/fixture/other-bound.git",
          },
        ],
        { githubConnectionId: f.connectionId },
      )

      expect(created).toEqual([])
      expect(await bindingOf(f, linked?.id)).toBe(f.connectionId)
      expect(await bindingOf(f, otherId)).toBe(otherConnectionId)
    })
  },
)
