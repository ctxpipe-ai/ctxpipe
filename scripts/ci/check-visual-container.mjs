// The Playwright image of the screenshot capture (scripts/ci/visual-container.json)
// has the version of `playwright` that the lockfile gives to apps/ui.
//
// Mac and Linux render text differently, so every screenshot is taken in this
// one image (scripts/ci/visual-capture.mjs). The browser inside the image must
// be the browser that the repo tests with, so the tag follows the lockfile.
//
// This check reads files only. The `visual-container` prerequisite
// (scripts/checks/prerequisites.mjs) checks that the digest has the browsers of
// that version.
//
// The check fails when:
//   - the tag is not `v<lockfile version>-noble`;
//   - the digest is not a sha256 digest, or the platform is not linux/arm64.
//
// Usage: node scripts/ci/check-visual-container.mjs [repo root]   (default: this repo)

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(
  process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url)),
)

const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8")
const pin = JSON.parse(
  readFileSync(join(root, "scripts/ci/visual-container.json"), "utf8"),
)

// The importer block of apps/ui, then its `playwright` entry.
const importer = lockfile.match(/^ {2}apps\/ui:\n((?: {4}.*\n|\n)+)/m)?.[1]
const version = importer?.match(
  /^ {6}playwright:\n {8}specifier: .*\n {8}version: (\d+\.\d+\.\d+)\n/m,
)?.[1]

const problems = []
if (!version)
  problems.push("pnpm-lock.yaml has no `playwright` version for apps/ui.")
else if (pin.tag !== `v${version}-noble`)
  problems.push(
    `The tag is ${pin.tag}, but the lockfile has playwright ${version}. Set the tag to v${version}-noble and pin its linux/arm64 digest (docker buildx imagetools inspect ${pin.image}:v${version}-noble).`,
  )
if (!/^sha256:[0-9a-f]{64}$/.test(pin.digest ?? ""))
  problems.push("The digest must be a sha256 digest of the image manifest.")
if (pin.platform !== "linux/arm64")
  problems.push("The platform must be linux/arm64.")

if (problems.length) {
  process.stderr.write(
    `scripts/ci/visual-container.json is out of step:\n${problems.map((problem) => `- ${problem}`).join("\n")}\n`,
  )
  process.exitCode = 1
}
