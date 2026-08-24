import { config } from "dotenv"
import { ownerUrlForMigrate } from "./owner-migrate-url.js"

config({ path: ".env.local", quiet: true })
config({ path: ".env", quiet: true })

const url = process.env.DATABASE_URL
if (!url) {
  throw new Error("DATABASE_URL is required for migrate")
}
process.stdout.write(ownerUrlForMigrate(url))
