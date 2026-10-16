// Fails when a workflow `env:` block reads a password or database URL step
// output. GitHub prints `env:` before the step runs, and an action output is
// not masked by default, so the value would show in the log.
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const directory = join(root, ".github", "workflows")
const credential = /\$\{\{[^}]*\boutputs\.(password|db_url\w*)\b[^}]*\}\}/
const failures = []

for (const name of readdirSync(directory).filter((file) => /\.ya?ml$/.test(file))) {
  const lines = readFileSync(join(directory, name), "utf8").split("\n")
  let envIndent = -1
  lines.forEach((line, index) => {
    if (line.trim() === "" || line.trim().startsWith("#")) return
    const indent = line.length - line.trimStart().length
    if (envIndent >= 0 && indent <= envIndent) envIndent = -1
    if (/^\s*(-\s+)?env:\s*$/.test(line)) {
      envIndent = indent
      return
    }
    if (envIndent >= 0 && credential.test(line)) {
      failures.push(
        `.github/workflows/${name}:${index + 1}: an env: block reads a password or db_url output. Mask the value, write it to $GITHUB_ENV, and read it from the shell.`,
      )
    }
  })
}

if (failures.length > 0) {
  console.error(failures.join("\n"))
  process.exit(1)
}
