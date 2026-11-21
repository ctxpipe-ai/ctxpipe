// Every story file is CSF 4 (the storybook skill, "Story format"): its meta is
// `preview.meta(...)` and each story is `meta.story(...)`. A CSF 4 file gets
// the types of the story parameters (`.storybook/parameters-addon.ts`) and
// adds its MSW handlers in `beforeEach({ msw })`.
//
// The check fails when:
//   - a story file is CSF 3 (`export default meta`);
//   - a story file sets `msw:`. The addon ignores `parameters.msw`, so the
//     handlers would do nothing.
//
// Usage: node scripts/ci/check-story-format.mjs [repo root]   (default: this repo)

import { readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { csfTools } from "../../apps/ui/.storybook/check-modules.mjs"
import { storyFiles } from "../../packages/visual-review/src/story-tags.ts"

const root = resolve(
  process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url)),
)
const { loadCsf } = await csfTools()

const errors = []
const files = storyFiles(join(root, "apps/ui/src"))
for (const path of files) {
  const file = relative(root, path)
  const code = readFileSync(path, "utf8")
  const csf = loadCsf(code, {
    fileName: file,
    makeTitle: (title) => title,
  }).parse()
  const csf4 = csf._metaIsFactory === true
  // `msw:` also finds a helper that returns it; the parsed keys also find
  // the shorthand `parameters: { msw }`.
  const setsMsw =
    /\bmsw\s*:/.test(code) ||
    [csf._metaAnnotations, ...Object.values(csf._storyAnnotations)].some(
      (annotations) =>
        annotations?.parameters?.properties?.some(
          (property) => (property.key?.name ?? property.key?.value) === "msw",
        ),
    )
  if (!csf4)
    errors.push(
      `${file} is CSF 3. Write it in CSF 4: \`const meta = preview.meta({ ... })\` and \`export const <Name> = meta.story({ ... })\` (the storybook skill, "Story format").`,
    )
  if (setsMsw)
    errors.push(
      `${file} sets \`msw:\`. A story file adds its handlers in \`beforeEach({ msw }) { msw.use(...) }\` of its meta or its story; the addon ignores parameters.msw there.`,
    )
}
for (const error of errors) console.error(error)
if (errors.length) process.exit(1)
console.log(
  `Story format check passed (${files.length} story files).`,
)
