import { config } from "dotenv"
import { ownerUrlForMigrate } from "./owner-migrate-url.js"

config({ path: ".env.local" })
config({ path: ".env" })

const url = process.env.DATABASE_URL
if (!url) {
  throw new Error("DATABASE_URL is required for migrate")
}
process.stdout.write(ownerUrlForMigrate(url))
