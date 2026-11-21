// Each React component of apps/ui is rendered by the product, not only by a
// story or a test. A story shows only UI that people can see in the product.
//
// knip.json makes the stories and the tests entry files of apps/ui, so the
// knip lint does not find a component that only a story or a test imports.
// This check runs knip again on apps/ui with only the product entries of
// knip.json: it removes the story, test, typecheck and Storybook entries,
// and it turns off the knip plugins that add them again (Storybook, Vitest,
// Playwright, and Vite, which reads the Vitest config).
//
// The check fails for a component that the product does not reach:
//   - a `.tsx` file that no product file imports;
//   - an exported PascalCase name of a `.tsx` file that no product file
//     imports and that its own file does not use.
// A story-support file is not a product file. It is in a `mocks/` folder, or a
// word of its name is "story" or "stories". The check does not report it.
//
// Usage: node scripts/ci/check-product-components.mjs [repository root]

import { spawnSync } from "node:child_process"
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repo = fileURLToPath(new URL("../..", import.meta.url))
// knip compares real paths: a root behind a symlink (the macOS tmpdir) loses
// its entries.
const root = realpathSync(resolve(process.argv[2] ?? repo))

const config = JSON.parse(readFileSync(join(root, "knip.json"), "utf8"))
const ui = config.workspaces["apps/ui"]
const nonProduct = /stories|test|typecheck|storybook/
const product = {
  ...ui,
  entry: [
    ...ui.entry.filter((pattern) => !nonProduct.test(pattern)),
    // A broad product entry (src/routes/**) also matches the stories and the
    // tests in its folder.
    "!src/**/*.stories.tsx",
    "!src/**/*.test.{ts,tsx}",
  ],
  project: [
    ...ui.project.filter((pattern) => !nonProduct.test(pattern)),
    "!src/**/*.stories.tsx",
    "!src/**/*.test.{ts,tsx}",
    "!src/**/*.typecheck.ts",
  ],
  storybook: false,
  vitest: false,
  playwright: false,
  vite: false,
}

const dir = mkdtempSync(join(tmpdir(), "ctxpipe-product-components-"))
let result
try {
  const file = join(dir, "knip.json")
  writeFileSync(
    file,
    JSON.stringify({
      ...config,
      ignoreExportsUsedInFile: true,
      includeEntryExports: true,
      workspaces: { "apps/ui": product },
    }),
  )
  result = spawnSync(
    process.execPath,
    [
      join(repo, "node_modules/knip/bin/knip.js"),
      ...["--directory", root, "--config", file, "--workspace", "apps/ui"],
      ...["--include", "files,exports", "--reporter", "json", "--no-exit-code"],
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
if (result.status !== 0) {
  process.stderr.write(result.stderr)
  console.error("Product component check: knip did not run.")
  process.exit(1)
}

const report = JSON.parse(result.stdout)
// "story" or "stories" starts a word of the file name: `source-dialog-story-
// frame.tsx` or `skeletonMatchStory.tsx`, not `ChatHistory.tsx`.
const storySupport = (file) =>
  /(^|\/)mocks\//.test(file) ||
  /(^|[^a-zA-Z])stor(y|ies)|Stor(y|ies)/.test(basename(file))
const component = (file) => file.endsWith(".tsx") && !storySupport(file)
const unused = [
  ...report.files.filter(component).map((file) => `${file} (no product import)`),
  ...report.issues
    .filter(({ file }) => component(file))
    .flatMap(({ file, exports }) =>
      exports
        .filter(({ name }) => /^[A-Z]/.test(name))
        .map(({ name, line }) => `${file}:${line} ${name}`),
    ),
]

if (unused.length > 0) {
  console.error(
    "Components that only a story or a test renders. Delete each one with its stories, tests and screenshot baselines, or render it in the product:",
  )
  for (const entry of unused) console.error(`  ${entry}`)
  process.exit(1)
}
console.log("Product component check passed.")
