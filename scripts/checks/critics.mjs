import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const file = ".agents/skills/code-review/critics.json"

// The critics of the code-review skill as manifest records (family `critic`).
// An agent runs a critic, not `checks:run`. The `version` is a hash of the
// critic's definition and of the text of its inputs, so a change to its skill
// text gives a new version, and a reader does not reuse an older verdict.
export function listCritics() {
  const { critics } = JSON.parse(readFileSync(root + file, "utf8"))
  return critics.map(({ name, ...definition }) => {
    const hash = createHash("sha256").update(JSON.stringify(definition))
    for (const input of definition.inputs)
      hash.update(`\0${input}\0`).update(readFileSync(root + input))
    return {
      id: `critic:${name}`,
      family: "critic",
      file,
      version: hash.digest("hex"),
      ...definition,
    }
  })
}
