import { config } from "dotenv"
import { parseEnv } from "../config/env.js"
import { backfillGithubAppSecretsFromEnv } from "../scripts/backfillGithubConnectionSecrets.js"
import { closeDb, initDb } from "./client.js"

config({ path: ".env.local", quiet: true })
config({ path: ".env", quiet: true })

const url = process.env.DATABASE_URL
if (!url) throw new Error("DATABASE_URL is required")
try {
  initDb(url)
  await backfillGithubAppSecretsFromEnv(
    parseEnv(process.env as Record<string, string | undefined>),
  )
} finally {
  await closeDb()
}
