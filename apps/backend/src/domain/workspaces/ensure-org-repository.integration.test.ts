import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import { connections } from "../../db/schema/connections.js"
import { repositories } from "../../db/schema/repositories.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { ensureOrgRepositoryForGitUrl } from "./ensure-org-repository.js"

type Fixture = Parameters<Parameters<typeof withNativeHydrationFixture>[1]>[0]

const otherInstallationId = 987654321

/** GitHub's view of an installation's account, as the App reads it. */
function githubAccount(installationId: number, login: string) {
  return [
    http.get(`https://api.github.com/app/installations/${installationId}`, () =>
      HttpResponse.json({ id: installationId, account: { login } }),
    ),
    http.post(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      () =>
        HttpResponse.json({
          token: "fixture-only-github-read-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
    ),
  ]
}

async function setAccountSlug(f: Fixture, accountSlug: string | undefined) {
  await withOrgDbContext(f.org.id, (db) =>
    db
      .update(connections)
      .set({
        config: {
          installationId: 123456789,
          ...(accountSlug ? { accountSlug } : {}),
          ingestAllRepositories: false,
          includeFutureRepos: false,
        },
      })
      .where(eq(connections.id, f.connectionId)),
  )
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

async function storedAccountSlug(f: Fixture) {
  const [row] = await withOrgDbContext(f.org.id, (db) =>
    db
      .select({ config: connections.config })
      .from(connections)
      .where(eq(connections.id, f.connectionId)),
  )
  return (row?.config as { accountSlug?: string } | undefined)?.accountSlug
}

it(
  "binds a linked repository to the Workspace's connection only within the installation's account",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      await setAccountSlug(f, "fixture")
      // A public dependency that an earlier link bound to this connection.
      const staleId = `repo_${f.id}_stale`
      await insertRepository(
        f,
        staleId,
        "https://github.com/upstream/stale-dependency",
        f.connectionId,
      )
      f.server.use(...githubAccount(123456789, "fixture"))

      const own = await link(
        f,
        "https://github.com/fixture/own-service",
        f.connectionId,
      )
      const foreign = await link(
        f,
        "https://github.com/upstream/public-dependency",
        f.connectionId,
      )
      await link(
        f,
        "https://github.com/upstream/stale-dependency",
        f.connectionId,
      )

      expect(await bindingOf(f, own?.id)).toBe(f.connectionId)
      expect(await bindingOf(f, foreign?.id)).toBeNull()
      expect(await bindingOf(f, staleId)).toBeNull()
    })
  },
)

it(
  "keeps a repository bound to the connection that covers it when another Workspace links it",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      await setAccountSlug(f, "fixture")
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
      f.server.use(...githubAccount(otherInstallationId, "other-account"))

      await link(
        f,
        "https://github.com/fixture/private-service",
        otherConnectionId,
      )

      expect(await bindingOf(f, privateId)).toBe(f.connectionId)
      await withOrgDbContext(f.org.id, (db) =>
        db.delete(connections).where(eq(connections.id, otherConnectionId)),
      )
    })
  },
)

it(
  "refreshes a renamed installation account before it decides the owner does not match",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      await setAccountSlug(f, "old-org-name")
      f.server.use(...githubAccount(123456789, "fixture"))

      const own = await link(
        f,
        "https://github.com/fixture/private-service",
        f.connectionId,
      )

      expect(await bindingOf(f, own?.id)).toBe(f.connectionId)
      expect(await storedAccountSlug(f)).toBe("fixture")
    })
  },
)

it(
  "reads the account of a legacy connection without a stored slug from GitHub",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      await setAccountSlug(f, undefined)
      f.server.use(...githubAccount(123456789, "fixture"))

      const foreign = await link(
        f,
        "https://github.com/upstream/public-dependency",
        f.connectionId,
      )
      const own = await link(
        f,
        "https://github.com/fixture/own-service",
        f.connectionId,
      )

      expect(await bindingOf(f, foreign?.id)).toBeNull()
      expect(await bindingOf(f, own?.id)).toBe(f.connectionId)
      expect(await storedAccountSlug(f)).toBe("fixture")
    })
  },
)

it(
  "changes no binding when GitHub cannot confirm the installation's account",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture({ github: true }, async (f) => {
      await setAccountSlug(f, "old-org-name")
      const boundId = `repo_${f.id}_bound`
      await insertRepository(
        f,
        boundId,
        "https://github.com/fixture/bound-service",
        f.connectionId,
      )
      f.server.use(
        http.get(
          "https://api.github.com/app/installations/123456789",
          () => new HttpResponse(null, { status: 404 }),
        ),
      )

      const bound = await link(
        f,
        "https://github.com/fixture/bound-service",
        f.connectionId,
      )
      const created = await link(
        f,
        "https://github.com/fixture/new-service",
        f.connectionId,
      )

      expect(await bindingOf(f, bound?.id)).toBe(f.connectionId)
      expect(created?.created).toBe(true)
      expect(await bindingOf(f, created?.id)).toBeNull()
      expect(await storedAccountSlug(f)).toBe("old-org-name")
    })
  },
)
