import { delimiter, isAbsolute, sep } from "node:path"

// Prints the check manifest (schema/manifest.v1.schema.json) as JSON.
//
// The merge gate manifest job runs this file with an absolute Node path, not
// through `pnpm run`, so that a dependency bin cannot take over the step. A
// command that the listing starts (`git`, Node) must not resolve to a bin of
// a dependency either: thus PATH keeps only the absolute directories outside
// node_modules, before the listing code loads.
process.env.PATH = (process.env.PATH ?? "")
  .split(delimiter)
  .filter(
    (entry) =>
      isAbsolute(entry) &&
      !`${entry}${sep}`.includes(`${sep}node_modules${sep}`),
  )
  .join(delimiter)
try {
  const { listChecks } = await import("./families.mjs")
  process.stdout.write(`${JSON.stringify(await listChecks())}\n`)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
