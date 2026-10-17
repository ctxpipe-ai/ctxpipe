// Fails when a workflow reads a password or database URL step output in an
// expression. GitHub prints `env:` values and the expanded text of a `run:`
// script, and prints `with:` inputs, before the step runs. An action output is
// not masked by default, so the value would show in the log. The check scans
// every line of every workflow and every local action, not only `env:` blocks.
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const credential = /\$\{\{[^}]*\boutputs\.(password|db_url\w*)\b[^}]*\}\}/
const failures = []

const files = [
  ...readdirSync(join(root, ".github", "workflows"))
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => join(".github", "workflows", file)),
  ...readdirSync(join(root, ".github", "actions"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      readdirSync(join(root, ".github", "actions", entry.name))
        .filter((file) => /^action\.ya?ml$/.test(file))
        .map((file) => join(".github", "actions", entry.name, file)),
    ),
]

for (const file of files) {
  readFileSync(join(root, file), "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (line.trim().startsWith("#")) return
      if (credential.test(line)) {
        failures.push(
          `${file}:${index + 1}: an expression reads a password or db_url output in an env:, run: or with: value. Mask the value, write it to $GITHUB_ENV, and read it from the shell.`,
        )
      }
    })
}

if (failures.length > 0) {
  console.error(failures.join("\n"))
  process.exit(1)
}
