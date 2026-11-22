import { listChecks } from "./families.mjs"
import { withRunnerInputs } from "./runner-inputs.mjs"

// Prints the check manifest (schema/manifest.v1.schema.json) as JSON.
try {
  process.stdout.write(`${JSON.stringify(withRunnerInputs(await listChecks()))}\n`)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
