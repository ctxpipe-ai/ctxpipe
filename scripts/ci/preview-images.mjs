import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  changedPaths,
  covers,
  github,
  images,
  inputsOf,
  lastDeploy,
  matrixEntry,
  noticeDigests,
  uncoveredSources,
} from "./deploy-images.mjs"

// The images of a pull request for its AWS preview
// (.github/workflows/pr-preview-images.yaml), and which of them a run builds.
//
// An image builds only when one of its inputs (deploy-images.mjs) changed
// since an image that exists already. Each other image keeps that image:
// - first the image of the newest earlier successful re-run of the workflow
//   for the same PR (`pr`, in the ECR repository ctxpipe-pr/<image>), when the
//   workflow file at that run's commit is the file at the PR head, and no
//   local action (.github/actions) changed since: the build job runs one, so
//   a PR could change it, build, and change it back;
// - else the image of the last successful Deploy run on main (`main`, the
//   multi-platform image on GHCR, of which the push job copies the
//   linux/arm64 image), when deploy.yaml did not change since.
// The digest of a base is the one notice that its push or publish job
// reported (noticeDigests). The push job of the workflow copies a kept image
// by that digest, under the tag of the run, and reports the digest again.
//
// Every image builds when the GitHub API or git fails. An image builds when
// its Dockerfile reads a path that its inputs do not cover.
//
// Usage (pr-preview-images.yaml, job plan, with the version of this file on
// the PR base): node preview-images.mjs <checkout of the PR head>
// It writes `build` (the matrix of the build jobs) and `reuse` (image to
// "<pr|main> <digest>") to $GITHUB_OUTPUT.

const previewImages = images.filter(({ image }) =>
  ["backend", "worker", "ui", "codesearch"].includes(image),
)
const names = previewImages.map(({ image }) => image)
const workflow = ".github/workflows/pr-preview-images.yaml"

const git = (root, ...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 256 * 1024 * 1024,
  })

// The newest earlier successful re-run of the workflow for PR `pr` whose push
// jobs reported digests, with the same workflow file as the PR head: a run of
// another version of the file could have reported any digest. A first attempt
// builds nothing. A run in progress, this one too, is not in the list.
async function lastPreview({ root, repo, token, pr, head, branch }) {
  const fileAt = (sha) => git(root, "rev-parse", `${sha}:${workflow}`).trim()
  const current = fileAt(head)
  const { workflow_runs: runs } = await github(
    `/repos/${repo}/actions/workflows/pr-preview-images.yaml/runs?branch=${encodeURIComponent(branch)}&event=pull_request&status=success&per_page=20`,
    token,
  )
  for (const candidate of runs) {
    if (
      candidate.run_attempt === 1 ||
      !/^[0-9a-f]{40}$/.test(candidate.head_sha) ||
      candidate.pull_requests?.length !== 1 ||
      String(candidate.pull_requests[0].number) !== String(pr)
    )
      continue
    try {
      if (fileAt(candidate.head_sha) !== current) continue
    } catch {
      continue
    }
    const { jobs } = await github(
      `/repos/${repo}/actions/runs/${candidate.id}/jobs?filter=latest&per_page=100`,
      token,
    )
    if (
      !jobs.some(
        ({ name, conclusion }) =>
          name.startsWith("Push preview image (") && conclusion === "success",
      )
    )
      continue
    const digests = await noticeDigests({
      repo,
      jobs,
      token,
      names,
      jobName: (image) => `Push preview image (${image})`,
      title: "preview-image",
    })
    return { run: candidate, digests }
  }
  return undefined
}

/**
 * Which preview images this run builds, and the image that each other image
 * keeps: `{ build: [matrix entry], reuse: { image: "<pr|main> <digest>" },
 * reasons: { image: text } }`.
 */
export async function planPreviewImages({
  root,
  repo,
  token,
  pr,
  head,
  branch,
}) {
  const everything = (reason) => ({
    build: previewImages.map(matrixEntry),
    reuse: {},
    reasons: Object.fromEntries(names.map((image) => [image, reason])),
  })
  const bases = []
  try {
    const preview = await lastPreview({
      root,
      repo,
      token,
      pr,
      head,
      branch,
    })
    const sincePreview =
      preview && changedPaths(root, preview.run.head_sha, head)
    if (sincePreview?.every((path) => !path.startsWith(".github/actions/")))
      bases.push({
        from: "pr",
        sha: preview.run.head_sha,
        digests: preview.digests,
        changed: sincePreview,
      })
    const deploy = await lastDeploy({ repo, token })
    if (deploy && /^[0-9a-f]{40}$/.test(deploy.run.head_sha)) {
      const changed = changedPaths(root, deploy.run.head_sha, head)
      // A change to the deploy workflow can change how main builds an image.
      if (!changed.includes(".github/workflows/deploy.yaml"))
        bases.push({
          from: "main",
          sha: deploy.run.head_sha,
          digests: deploy.digests,
          changed,
        })
    }
  } catch (error) {
    return everything(`no base: ${error.message}`)
  }
  const result = { build: [], reuse: {}, reasons: {} }
  for (const image of previewImages) {
    const uncovered = uncoveredSources(root, image)
    const why = []
    const base = uncovered.length
      ? undefined
      : bases.find(({ from, sha, digests, changed }) => {
          const touched = changed.find((path) => covers(inputsOf(image), path))
          const reason = touched
            ? `${touched} changed since ${sha.slice(0, 7)}`
            : digests[image.image].reason
          if (reason) why.push(`${from}: ${reason}`)
          return !reason
        })
    if (base) {
      const { digest } = base.digests[image.image]
      result.reuse[image.image] = `${base.from} ${digest}`
      result.reasons[image.image] =
        `no input changed since ${base.from} ${base.sha.slice(0, 7)}: reuses ${digest}`
    } else {
      result.build.push(matrixEntry(image))
      result.reasons[image.image] = uncovered.length
        ? `its Dockerfile reads paths that its inputs do not cover: ${uncovered.join(", ")}`
        : why.join("; ") || "no earlier image"
    }
  }
  return result
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const env = process.env
  const result = await planPreviewImages({
    root: process.argv[2] ?? fileURLToPath(new URL("../../", import.meta.url)),
    repo: env.GITHUB_REPOSITORY,
    token: env.GH_TOKEN,
    pr: env.PR,
    head: env.HEAD_SHA,
    branch: env.BRANCH,
  })
  const lines = [
    `build=${JSON.stringify(result.build)}`,
    `reuse=${JSON.stringify(result.reuse)}`,
  ]
  const summary = [
    "| Image | Plan |",
    "| --- | --- |",
    ...names.map(
      (image) =>
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
