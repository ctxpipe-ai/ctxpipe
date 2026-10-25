import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { config } from "dotenv"
import { eq, inArray, sql } from "drizzle-orm"
import { Client } from "pg"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { twoFactors, users } from "../db/schema/auth.js"
import { getAuth, resetBetterAuthForTests } from "./config.js"

config({
  path: resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../.env.local",
  ),
  quiet: true,
})

const base = "http://localhost:3000"
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const password = "two-factor-password-1"
const emails: string[] = []

function post(path: string, body: Record<string, unknown>, cookie: string) {
  return getAuth().handler(
    new Request(`${base}/.auth/api/v1/auth${path}`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  )
}

function cookieOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((part) => part.split(";")[0])
    .join("; ")
}

/** RFC 6238 code (SHA-1, 6 digits, 30 s) for the base32 secret of a TOTP URI. */
function totpCode(totpURI: string): string {
  const base32 = new URL(totpURI).searchParams.get("secret") as string
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = ""
  for (const char of base32.toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0")
  }
  const key = Buffer.from(
    bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? [],
  )
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
  const hmac = createHmac("sha1", key).update(counter).digest()
  const offset = (hmac.at(-1) as number) & 15
  const value = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return value.toString().padStart(6, "0")
}

async function twoFactorRow(userId: string) {
  const [row] = await getSystemDb()
    .select()
    .from(twoFactors)
    .where(eq(twoFactors.userId, userId))
  return row
}

const migrationStatements = [
  "20261025060007_two_factor_lockout_columns",
  "20261025060017_two_factor_unfinished_unverified",
  "20261025070554_two_factor_stranded_disabled",
].flatMap((migration) =>
  readFileSync(
    resolve(
      fileURLToPath(new URL(".", import.meta.url)),
      `../../migrations/${migration}/migration.sql`,
    ),
    "utf8",
  )
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0),
)

describe("two-factor (Postgres)", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
  })

  beforeEach(() => {
    vi.stubEnv("AUTH_BASE_URL", base)
    vi.stubEnv("SMTP_CONNECTION_URL", "")
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "")
    resetBetterAuthForTests()
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    resetBetterAuthForTests()
    if (emails.length > 0) {
      await getSystemDb().delete(users).where(inArray(users.email, emails))
    }
    await closeDb()
  })

  it("enables two-factor, confirms it with a TOTP code, and counts and clears failed sign-in codes", async () => {
    const email = `two-factor-${suffix}@example.com`
    emails.push(email)
    const signedUp = await post(
      "/sign-up/email",
      { name: "Two factor", email, password },
      "",
    )
    expect(signedUp.status).toBe(200)
    const session = cookieOf(signedUp)
    const userId = ((await signedUp.json()) as { user: { id: string } }).user.id

    const enabled = await post("/two-factor/enable", { password }, session)

    expect(enabled.status).toBe(200)
    const { totpURI } = (await enabled.json()) as { totpURI: string }
    expect(await twoFactorRow(userId)).toMatchObject({
      verified: false,
      failedVerificationCount: 0,
      lockedUntil: null,
    })

    const confirmed = await post(
      "/two-factor/verify-totp",
      { code: totpCode(totpURI) },
      session,
    )

    expect(confirmed.status).toBe(200)
    expect(await twoFactorRow(userId)).toMatchObject({ verified: true })

    const signIn = await post("/sign-in/email", { email, password }, "")
    expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true })
    const challenge = cookieOf(signIn)

    const wrong = await post(
      "/two-factor/verify-totp",
      { code: totpCode(totpURI) === "000000" ? "000001" : "000000" },
      challenge,
    )

    expect(wrong.status).toBe(401)
    expect(await twoFactorRow(userId)).toMatchObject({
      failedVerificationCount: 1,
    })

    const right = await post(
      "/two-factor/verify-totp",
      { code: totpCode(totpURI) },
      challenge,
    )

    expect(right.status).toBe(200)
    expect(await twoFactorRow(userId)).toMatchObject({
      failedVerificationCount: 0,
      lockedUntil: null,
    })
  })

  it("the migration marks an unfinished legacy factor as unverified and keeps a finished one verified", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    try {
      // Temp tables shadow the real ones for this connection only, in the legacy shape.
      await client.query(
        "CREATE TEMP TABLE users (id text PRIMARY KEY, two_factor_enabled boolean DEFAULT false)",
      )
      await client.query(
        "CREATE TEMP TABLE two_factors (id text PRIMARY KEY, secret text, user_id text NOT NULL)",
      )
      await client.query(
        "INSERT INTO users (id, two_factor_enabled) VALUES ('abandoned', false), ('unset', NULL), ('finished', true)",
      )
      await client.query(
        "INSERT INTO two_factors (id, secret, user_id) VALUES ('f1', 's', 'abandoned'), ('f2', 's', 'unset'), ('f3', 's', 'finished')",
      )

      for (const statement of migrationStatements) await client.query(statement)

      const { rows } = await client.query(
        "SELECT user_id, verified FROM two_factors ORDER BY user_id",
      )
      expect(rows).toEqual([
        { user_id: "abandoned", verified: false },
        { user_id: "finished", verified: true },
        { user_id: "unset", verified: false },
      ])
    } finally {
      await client.end()
    }
  })

  it("the migration turns two-factor off for a user with no factor row and keeps it on for a user with a row", async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    try {
      // Temp tables shadow the real ones for this connection only, in the legacy shape.
      await client.query(
        "CREATE TEMP TABLE users (id text PRIMARY KEY, two_factor_enabled boolean DEFAULT false)",
      )
      await client.query(
        "CREATE TEMP TABLE two_factors (id text PRIMARY KEY, secret text, user_id text NOT NULL)",
      )
      await client.query(
        "INSERT INTO users (id, two_factor_enabled) VALUES ('stranded', true), ('finished', true), ('off', false)",
      )
      await client.query(
        "INSERT INTO two_factors (id, secret, user_id) VALUES ('f1', 's', 'finished')",
      )

      for (const statement of migrationStatements) await client.query(statement)

      const { rows } = await client.query(
        "SELECT id, two_factor_enabled FROM users ORDER BY id",
      )
      expect(rows).toEqual([
        { id: "finished", two_factor_enabled: true },
        { id: "off", two_factor_enabled: false },
        { id: "stranded", two_factor_enabled: false },
      ])
    } finally {
      await client.end()
    }
  })

  it("turns two-factor on when a user with an unfinished legacy factor enables it again and confirms", async () => {
    const email = `two-factor-legacy-${suffix}@example.com`
    emails.push(email)
    const signedUp = await post(
      "/sign-up/email",
      { name: "Legacy factor", email, password },
      "",
    )
    const session = cookieOf(signedUp)
    const userId = ((await signedUp.json()) as { user: { id: string } }).user.id
    // The state the migration finds: a factor row from before the column existed.
    await getSystemDb()
      .insert(twoFactors)
      .values({
        id: `legacy-${suffix}`,
        secret: "legacy",
        backupCodes: "legacy",
        userId,
        verified: true,
      })
    const update = migrationStatements.find((statement) =>
      statement.includes('UPDATE "two_factors"'),
    ) as string
    await getSystemDb().execute(sql.raw(update))
    expect(await twoFactorRow(userId)).toMatchObject({ verified: false })

    const enabled = await post("/two-factor/enable", { password }, session)
    const { totpURI } = (await enabled.json()) as { totpURI: string }
    const confirmed = await post(
      "/two-factor/verify-totp",
      { code: totpCode(totpURI) },
      session,
    )

    expect(confirmed.status).toBe(200)
    const [user] = await getSystemDb()
      .select({ twoFactorEnabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, userId))
    expect(user?.twoFactorEnabled).toBe(true)
  })
})
