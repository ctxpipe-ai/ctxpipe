import { randomUUID } from "node:crypto"
import { closeSync, openSync, writeSync } from "node:fs"
import { parseArgs } from "node:util"

import { getAuth } from "../../src/auth/config.js"
import { getSystemDb, initDb } from "../../src/db/client.js"
import { members } from "../../src/db/schema/auth.js"
import { generateObjectId } from "../../src/lib/id.js"
import { initEvlog } from "../../src/observability/logger.js"

/*
 * Mint an org API key for the CTX arm of the bench (CTX-1660). The bench org
 * is an eval org with no member (`evals/knowledge` hydrate makes it), so the
 * script signs up a bench user, makes it the owner of the org, and makes an
 * org key through Better Auth, as `test/db.ts` does. It writes the key to
 * the new file `--out` (mode 0600; an existing file stops it) and never
 * prints it.
 *
 *   bun --env-file=BACKEND.env evals/bench/mint-key.ts --org ORG_ID --out KEY_FILE
 */

const { values } = parseArgs({
  options: { org: { type: "string" }, out: { type: "string" } },
})
if (!values.org || !values.out)
  throw new Error("Usage: mint-key.ts --org ORG_ID --out KEY_FILE")
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("DATABASE_URL is not set")
// Open the new key file before the key exists: an existing file or link stops
// the script before it makes a key.
const keyFile = openSync(values.out, "wx", 0o600)

initEvlog()
initDb(databaseUrl)
const auth = getAuth()
const origin = process.env.AUTH_BASE_URL ?? "http://localhost:3000"
const suffix = randomUUID().slice(0, 8)
const signUp = await auth.api.signUpEmail({
  body: {
    name: "Bench runner",
    email: `bench-${suffix}@example.com`,
    password: `bench-${randomUUID()}`,
  },
  headers: new Headers({ origin }),
  asResponse: true,
})
if (!signUp.ok)
  throw new Error(`signUpEmail failed: ${signUp.status} ${await signUp.text()}`)
const { user } = (await signUp.json()) as { user: { id: string } }
const cookie = signUp.headers
  .getSetCookie()
  .map((part) => part.split(";")[0]?.trim())
  .filter(Boolean)
  .join("; ")
await getSystemDb()
  .insert(members)
  .values({
    id: generateObjectId("member"),
    organizationId: values.org,
    userId: user.id,
    role: "owner",
    createdAt: new Date(),
  })
const key = await auth.api.createApiKey({
  body: {
    configId: "organization",
    name: `bench-${suffix}`,
    organizationId: values.org,
  },
  headers: new Headers({ origin, cookie }),
})
if (!key?.key) throw new Error("createApiKey did not return a key")
writeSync(keyFile, key.key)
closeSync(keyFile)
process.stdout.write(`wrote the org key of ${values.org} to ${values.out}\n`)
process.exit(0)
