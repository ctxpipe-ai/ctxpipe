// Every story file is CSF 4 (the storybook skill, "Story format"): its meta is
// `preview.meta(...)` and each story is `meta.story(...)`. A CSF 4 file gets
// the types of the story parameters (`.storybook/parameters-addon.ts`) and
// adds its MSW handlers in `beforeEach({ msw })`.
//
// The check fails when:
//   - a story file is CSF 3 (`export default meta`) and
//     `scripts/ci/csf3-story-files.json` does not list it. The list holds the
//     files that are not converted yet (CTX-1462). It only gets shorter;
//   - the list has a file that is CSF 4 now, or that does not exist. Then the
//     entry goes out of the list;
//   - a CSF 4 file sets `msw:`. The addon applies `parameters.msw` only to a
//     CSF 3 story, so in a CSF 4 file the handlers do nothing.
//
// Usage: node scripts/ci/check-story-format.mjs [repo root]   (default: this repo)

import { existsSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { csfTools } from "../../apps/ui/.storybook/check-modules.mjs"
import { storyFiles } from "../../packages/visual-review/src/story-tags.ts"

const root = resolve(
  process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url)),
)
const listFile = "scripts/ci/csf3-story-files.json"
const { loadCsf } = await csfTools()
const listed = new Set(JSON.parse(readFileSync(join(root, listFile), "utf8")))

const errors = []
const files = storyFiles(join(root, "apps/ui/src"))
for (const path of files) {
  const file = relative(root, path)
  const code = readFileSync(path, "utf8")
  const csf4 =
    loadCsf(code, { fileName: file, makeTitle: (title) => title }).parse()
      ._metaIsFactory === true
  if (csf4 && listed.has(file))
    errors.push(`${file} is CSF 4 now. Remove it from ${listFile}.`)
  if (!csf4 && !listed.has(file))
    errors.push(
      `${file} is CSF 3. Write it in CSF 4: \`const meta = preview.meta({ ... })\` and \`export const <Name> = meta.story({ ... })\` (the storybook skill, "Story format").`,
    )
  if (csf4 && /\bmsw\s*:/.test(code))
    errors.push(
      `${file} sets \`msw:\`. A CSF 4 story file adds its handlers in \`beforeEach({ msw }) { msw.use(...) }\` of its meta or its story; the addon ignores parameters.msw there.`,
    )
}
for (const file of listed)
  if (!existsSync(join(root, file)))
    errors.push(`${listFile} has ${file}, which does not exist. Remove it.`)

for (const error of errors) console.error(error)
if (errors.length) process.exit(1)
console.log(
  `Story format check passed (${files.length} story files, ${listed.size} not converted yet).`,
)
