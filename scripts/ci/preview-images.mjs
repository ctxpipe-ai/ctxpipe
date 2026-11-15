import { appendFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

import {
  changedPaths,
  covers,
  images,
  inputsOf,
  lastDeploy,
  matrixEntry,
  uncoveredSources,
} from "./deploy-images.mjs"

// The images of a pull request for its AWS preview
// (.github/workflows/pr-preview-images.yaml), and which of them a run builds.
//
// An image builds only when one of its inputs (deploy-images.mjs) differs
// between the PR head and the commit of the last successful Deploy run on
// main. Each other image keeps the image of that run. The digest is the one
// `deploy-image` notice of its Publish job (noticeDigests). The push job of
// the workflow copies the linux/arm64 image of that digest under the tag of
// the run.
//
// Only main is a base, not an earlier preview of the PR. The build job of a
// preview runs PR code (the local actions and the scripts that they call), so
// an earlier preview image can hold code that the PR head does not have.
//
// Every image builds when the GitHub API or git fails, when no base is found,
// or when deploy.yaml changed since the base. An image builds when its
// Dockerfile reads a path that its inputs do not cover.
//
// Usage (pr-preview-images.yaml, job plan, with the version of this file on
// the PR base): node preview-images.mjs <checkout of the PR head>
// It writes `build` (the matrix of the build jobs) and `reuse` (image to the
// digest on main) to $GITHUB_OUTPUT.

const previewImages = images.filter(({ image }) =>
  ["backend", "worker", "ui", "codesearch"].includes(image),
)

/**
 * Which preview images this run builds, and the digest on main of each other
 * image: `{ build: [matrix entry], reuse: { image: digest }, reasons: {
 * image: text } }`.
 */
export async function planPreviewImages({ root, repo, token, head }) {
  const everything = (reason) => ({
    build: previewImages.map(matrixEntry),
    reuse: {},
    reasons: Object.fromEntries(
      previewImages.map(({ image }) => [image, reason]),
    ),
  })
  let base
  let changed
  try {
    base = await lastDeploy({ repo, token })
    if (!base) return everything("no successful Deploy run on main")
    if (!/^[0-9a-f]{40}$/.test(base.run.head_sha))
      return everything("the base run has no commit")
    changed = changedPaths(root, base.run.head_sha, head)
  } catch (error) {
    return everything(`no base: ${error.message}`)
  }
  // A change to the deploy workflow can change how main builds an image.
  if (changed.includes(".github/workflows/deploy.yaml"))
    return everything(".github/workflows/deploy.yaml changed")
  const short = base.run.head_sha.slice(0, 7)
  const result = { build: [], reuse: {}, reasons: {} }
  for (const image of previewImages) {
    const uncovered = uncoveredSources(root, image)
    const touched = changed.find((path) => covers(inputsOf(image), path))
    const { digest, reason } = base.digests[image.image]
    const why = uncovered.length
      ? `its Dockerfile reads paths that its inputs do not cover: ${uncovered.join(", ")}`
      : touched
        ? `${touched} differs from ${short}`
        : reason
    if (why) {
      result.build.push(matrixEntry(image))
      result.reasons[image.image] = why
    } else {
      result.reuse[image.image] = digest
      result.reasons[image.image] =
        `no input differs from ${short}: reuses ${digest}`
    }
  }
  return result
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const env = process.env
  if (!process.argv[2])
    throw new Error("Usage: node preview-images.mjs <checkout of the PR head>")
  const result = await planPreviewImages({
    root: process.argv[2],
    repo: env.GITHUB_REPOSITORY,
    token: env.GH_TOKEN,
    head: env.HEAD_SHA,
  })
  const lines = [
    `build=${JSON.stringify(result.build)}`,
    `reuse=${JSON.stringify(result.reuse)}`,
  ]
  const summary = [
    "| Image | Plan |",
    "| --- | --- |",
    ...previewImages.map(
      ({ image }) =>
        `| ${image} | ${image in result.reuse ? "reuse" : "build"}: ${result.reasons[image]} |`,
    ),
  ]
  console.log(summary.join("\n"))
  if (env.GITHUB_OUTPUT)
    appendFileSync(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`)
  else console.log(lines.join("\n"))
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`)
}
