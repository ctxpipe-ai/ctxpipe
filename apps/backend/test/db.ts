import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq, inArray } from "drizzle-orm"
import { describe } from "vitest"
import { getAuth, resetBetterAuthForTests } from "../src/auth/config.js"
import { closeDb, getSystemDb, initDb } from "../src/db/client.js"
import { apikeys, organizations, users } from "../src/db/schema/auth.js"

const envFile = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../.env.local",
)
// CI sets DATABASE_URL on the job. Do not overwrite it with a laptop file.
config({ path: envFile, override: false, quiet: true })

export type SeededOrg = {
  orgId: string
  orgSlug: string
  userId: string
  email: string
  /** Raw `set-cookie` pair(s) from `signUpEmail`. Send as the `cookie` header. */
  cookie: string
  personalApiKey: string
  orgApiKey: string
}

function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL
}

/**
 * `describe.skipIf(!DATABASE_URL)` after `.env.local` is loaded.
 * Same gate as `github-pr-mirror.integration.test.ts`.
 */
export function describeWithDatabase(name: string, fn: () => void): void {
  describe.skipIf(!databaseUrl())(name, fn)
}

function requireDatabaseUrl(): string {
  const url = databaseUrl()
  if (!url) {
    throw new Error(
      "DATABASE_URL is unset. Add it to apps/backend/.env.local or the environment.",
    )
  }
  return url
}

function requireAuthSecret(): void {
  const secret = process.env.AUTH_SECRET
  if (!secret || secret.length < 32) {
    throw new Error(
      "AUTH_SECRET must be at least 32 characters to seed a user (apps/backend/.env.local).",
    )
  }
}

function sessionCookie(response: Response): string {
  const parts = response.headers.getSetCookie()
  const cookie = parts
    .map((part) => part.split(";")[0]?.trim())
    .filter((part): part is string => Boolean(part))
    .join("; ")
  if (!cookie) {
    throw new Error("signUpEmail did not set a session cookie")
  }
  return cookie
}

async function deleteSeededRows(ids: {
  userId?: string
  orgId?: string
}): Promise<void> {
  const db = getSystemDb()
  const referenceIds = [ids.userId, ids.orgId].filter(
    (id): id is string => typeof id === "string",
  )
  if (referenceIds.length > 0) {
    await db.delete(apikeys).where(inArray(apikeys.referenceId, referenceIds))
  }
  if (ids.orgId) {
    await db.delete(organizations).where(eq(organizations.id, ids.orgId))
  }
  if (ids.userId) {
    await db.delete(users).where(eq(users.id, ids.userId))
  }
}

/**
 * Org, user, personal API key, and org API key through Better Auth.
 * Suffixes ids the same way `github-pr-mirror.integration.test.ts` does.
 * Deletes rows on failure so a partial sign-up does not linger.
 */
export async function seedOrg(): Promise<SeededOrg> {
  const url = requireDatabaseUrl()
  requireAuthSecret()
  initDb(url)
  const auth = getAuth()
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const email = `seed-${suffix}@example.com`
  const origin = process.env.AUTH_BASE_URL ?? "http://localhost:3000"
  let userId: string | undefined
  let orgId: string | undefined

  try {
    const signUp = await auth.api.signUpEmail({
      body: {
        name: "Integration seed",
        email,
        password: "integration-seed-password",
      },
      headers: new Headers({ origin }),
      asResponse: true,
    })
    if (!signUp.ok) {
      throw new Error(
        `signUpEmail failed: ${signUp.status} ${await signUp.text()}`,
      )
    }
    const signedUp = (await signUp.json()) as {
      user: { id: string; email: string }
    }
    userId = signedUp.user.id
    const cookie = sessionCookie(signUp)
    const headers = new Headers({ origin, cookie })

    const org = await auth.api.createOrganization({
      body: {
        name: `Seed ${suffix}`,
        slug: `seed-${suffix}`,
      },
      headers,
    })
    if (!org?.id || !org.slug) {
      throw new Error("createOrganization did not return an id and slug")
    }
    orgId = org.id

    const personal = await auth.api.createApiKey({
      body: { name: "integration-personal" },
      headers,
    })
    if (!personal?.key) {
      throw new Error("createApiKey did not return a personal key")
    }

    const orgKey = await auth.api.createApiKey({
      body: {
        configId: "organization",
        name: "integration-org",
        organizationId: org.id,
      },
      headers,
    })
    if (!orgKey?.key) {
      throw new Error("createApiKey did not return an org key")
    }

    return {
      orgId: org.id,
      orgSlug: org.slug,
      userId,
      email: signedUp.user.email,
      cookie,
      personalApiKey: personal.key,
      orgApiKey: orgKey.key,
    }
  } catch (error) {
    if (userId || orgId) {
      await deleteSeededRows({ userId, orgId })
    }
    throw error
  }
}

/**
 * Deletes the seeded org (members cascade), user (sessions and accounts
 * cascade), and API keys. Closes the pool. Row deletes skip Better Auth's
 * organization-delete hook, which opens the graph.
 */
export async function cleanupSeededOrg(seed: SeededOrg): Promise<void> {
  await deleteSeededRows({ userId: seed.userId, orgId: seed.orgId })
  await closeDb()
  resetBetterAuthForTests()
}
