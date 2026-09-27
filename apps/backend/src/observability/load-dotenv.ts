import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
config({ path: resolve(backendRoot, ".env.local") })
config({ path: resolve(backendRoot, ".env") })
