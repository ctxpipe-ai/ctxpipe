import { createHmac } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest"
import { describeWithDatabase } from "../../test/db.js"
import { closeDb, getSystemDb, initDb } from "../db/client.js"
import { twoFactors, users } from "../db/schema/auth.js"
import { getAuth, resetBetterAuthForTests } from "./config.js"

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

describeWithDatabase("two-factor (Postgres)", () => {
  beforeAll(() => {
    initDb(process.env.DATABASE_URL as string)
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
})
