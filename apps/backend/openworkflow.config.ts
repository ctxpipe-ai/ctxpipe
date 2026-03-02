import { defineConfig } from "@openworkflow/cli"
import { BackendPostgres } from "openworkflow/postgres"

export default defineConfig({
  backend: await BackendPostgres.connect(process.env.DATABASE_URL!),
  dirs: ["./src/openworkflow"],
})
