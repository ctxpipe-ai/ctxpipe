import { pathToFileURL } from "node:url"

import {
  buildAll,
  images,
  lastDeploy,
  planFrom,
  writePlan,
} from "./deploy-images.mjs"

// The images of a pull request for its AWS preview
// (.github/workflows/pr-preview-images.yaml), and which of them a run builds.
//
// An image builds only when one of its inputs (deploy-images.mjs) differs
// between the PR head and the commit of the last successful Deploy run on
// main. Each other image keeps the image of that run. The digest is the one
// `deploy-image` notice of its Publish job. The push job of the workflow
// copies the linux/arm64 image of that digest under the tag of the run.
//
// Only main is a base, not an earlier preview of the PR. The build job of a
// preview runs PR code (the local actions and the scripts that they call).
// Thus an earlier preview image can hold code that the PR head does not have.
//
// Every image builds when the GitHub API or git fails, when no base is found,
// or when deploy.yaml or deploy-images.mjs changed since the base. The PR head need not contain
// the base commit: the plan compares the files of the two commits.
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
 * image (planFrom).
 */
export async function planPreviewImages({ root, repo, token, head }) {
  const everything = (reason) => buildAll(previewImages, reason)
  try {
    const base = await lastDeploy({ repo, token })
    if (!base) return everything("no successful Deploy run on main")
    if (!/^[0-9a-f]{40}$/.test(base.run.head_sha))
      return everything("the base run has no commit")
    return planFrom({
      root,
      list: previewImages,
      base,
      head,
      // The input rules of the PR can differ from the rules of this plan.
      everyImage: [
        ".github/workflows/deploy.yaml",
        "scripts/ci/deploy-images.mjs",
      ],
    })
  } catch (error) {
    return everything(`no base: ${error.message}`)
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!process.argv[2])
    throw new Error("Usage: node preview-images.mjs <checkout of the PR head>")
  const result = await planPreviewImages({
    root: process.argv[2],
    repo: process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN,
    head: process.env.HEAD_SHA,
  })
  writePlan(result, previewImages)
}
