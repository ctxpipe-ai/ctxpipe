#!/usr/bin/env node
// find-apis: list the HTTP operations that one code root of a source
// repository defines, as JSON that matches ../find.schema.json. It reads only
// tracked files at HEAD. The result is evidence for the model; the model
// groups the operations into APIs and the writer script writes the files.
//
// node find-apis.mjs --source /ctxpipe/source/<handle> --code-root <path> \
//   [--other-roots <discover-roots result file>]

import { readFileSync } from "node:fs"
import { fail } from "../../bin/stage-lib.mjs"
import { discoverApis } from "./apis-lib.mjs"

const argv = process.argv.slice(2)
const value = (name) => {
  const at = argv.indexOf(name)
  return at === -1 ? null : (argv[at + 1] ?? fail(`Give a value after ${name}`))
}
const source = value("--source") ?? fail("Give --source <checkout>")
const codeRoot = value("--code-root") ?? fail("Give --code-root <path>")
const othersFile = value("--other-roots")
let others = []
if (othersFile) {
  const listed = JSON.parse(readFileSync(othersFile, "utf8")).roots
  others = Array.isArray(listed)
    ? listed.map((r) => r?.path).filter((p) => typeof p === "string")
    : []
}
process.stdout.write(
  `${JSON.stringify(discoverApis(source, codeRoot, others))}\n`,
)
