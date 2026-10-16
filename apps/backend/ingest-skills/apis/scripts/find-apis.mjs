#!/usr/bin/env node
// find-apis: list the HTTP operations that one code root of a source
// repository defines, as JSON that matches ../find.schema.json. It reads only
// tracked files at HEAD. The result is evidence for the model; the model
// groups the operations into APIs and the writer script writes the files.
//
// node find-apis.mjs --source /ctxpipe/source/<handle> --source-url <url> --source-path <path> \
//   --roots <root-to-file map> --path <root path>
//
// The root-to-file map lists each root of the run; the script leaves out the
// files of nested roots.

import { readFileSync } from "node:fs"
import { stepArgs } from "../../bin/knowledge-lib.mjs"
import { fail } from "../../bin/stage-lib.mjs"
import { discoverApis } from "./apis-lib.mjs"

const { source, rootsFile, rootPath } = stepArgs()
const codeRoot = rootPath ?? fail("Give --path <root path>")
const listed = JSON.parse(readFileSync(rootsFile, "utf8")).roots
if (!Array.isArray(listed)) fail(`${rootsFile} has no roots list`)
const others = listed.map((r) => r?.path).filter((p) => typeof p === "string")
process.stdout.write(
  `${JSON.stringify(discoverApis(source, codeRoot, others))}\n`,
)
