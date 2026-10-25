import { listChecks } from "./lanes.mjs"

// Prints the check manifest (schema/manifest.v1.schema.json) as JSON.
try {
  process.stdout.write(`${JSON.stringify(await listChecks())}\n`)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
