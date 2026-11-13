import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { changedFiles } from "./changed-files.mjs"

// The images of deploy.yaml, and which of them a push to main builds.
//
// An image builds only when one of its inputs changed since the commit of the
// last successful Deploy run on main (the base). Each other image keeps the
// multi-platform image of the base run: publish_images gives that digest the
// tags <sha> and latest, so every later job works as for a built image.
//
// The inputs of an image are its Dockerfile, the .dockerignore of its build
// context, and the paths in `inputs`. A path covers each file whose path
// starts with it. `inputs` must cover each source that the Dockerfile copies
// (COPY, ADD, RUN --mount=type=bind) in the stages of the target: the test
// ci-deploy-images checks it, and the plan builds an image that copies an
// uncovered path, or that it cannot read, on each push.
//
// Every image builds when: the run is not a push; no successful Deploy run on
// main is found, or its commit is not in the history of HEAD; the GitHub API
// fails; or deploy.yaml or this file changed. One image builds when the base
// run has not exactly one valid `deploy-image` notice on its Publish job.
//
// Usage (deploy.yaml, job image_plan): node scripts/ci/deploy-images.mjs
// It writes `build` (the matrix of the build jobs), `reuse` (image to digest)
// and `images` (the matrix of publish_images) to $GITHUB_OUTPUT.

const workspace = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "patches",
]
const backend = [
  ...workspace,
  "shared",
  "apps/backend/package.json",
  "apps/backend/tsconfig.json",
  "apps/backend/src",
  "apps/backend/certs/rds-global-bundle.pem",
  "apps/backend/ingest-skills",
  "apps/backend/openworkflow.config.ts",
]

export const images = [
  {
    image: "backend",
    dockerfile: "apps/backend/Dockerfile",
    inputs: [...backend, "apps/backend/public", "apps/backend/migrations"],
  },
  {
    image: "worker",
    dockerfile: "apps/backend/Dockerfile.worker",
    inputs: backend,
  },
  {
    image: "ui",
    dockerfile: "apps/ui/Dockerfile",
    inputs: [
      ...workspace,
      "shared",
      "apps/ui",
      "apps/backend/package.json",
      "apps/backend/src",
    ],
  },
  {
    image: "codesearch",
    dockerfile: "apps/codesearch/Dockerfile",
    inputs: [
      ...workspace,
      "shared",
      "apps/codesearch/package.json",
      "apps/codesearch/tsconfig.json",
      "apps/codesearch/src",
      "apps/codesearch/scripts",
      "apps/codesearch/start.sh",
      "apps/codesearch/release-assets.txt",
    ],
  },
  // Workspace chat sandboxes.
  {
    image: "chat-sandbox",
    dockerfile: "scripts/chat-sandbox/Dockerfile",
    context: "scripts/chat-sandbox",
    inputs: ["scripts/chat-sandbox/node-http-proxy.cjs"],
  },
  // The AgentCore Runtime image of the chat sandbox: the `agentcore` target
  // of the same Dockerfile, with the shim as its entry point (CTX-1219).
  {
    image: "chat-sandbox-agentcore",
    dockerfile: "scripts/chat-sandbox/Dockerfile",
    context: "scripts/chat-sandbox",
    target: "agentcore",
    inputs: [
      "scripts/chat-sandbox/node-http-proxy.cjs",
      "scripts/chat-sandbox/agentcore-shim.mjs",
    ],
  },
]

// A change to one of these files can change how every image builds.
const everyImage = [
  ".github/workflows/deploy.yaml",
  "scripts/ci/deploy-images.mjs",
]

const inputsOf = ({ dockerfile, context = ".", inputs }) => [
  dockerfile,
  context === "." ? ".dockerignore" : `${context}/.dockerignore`,
  ...inputs,
]

const covers = (inputs, path) => inputs.some((input) => path.startsWith(input))

// The instructions of a Dockerfile, with continuation lines joined and
// comment lines removed.
function instructions(text) {
  const result = []
  let current = ""
  for (const line of text.split("\n")) {
    if (/^\s*#/.test(line)) continue
    const continued = /\\\s*$/.test(line)
    current += ` ${line.replace(/\\\s*$/, "")}`
    if (continued) continue
    const [keyword, ...rest] = current.trim().split(/\s+/)
    if (keyword)
      result.push({ keyword: keyword.toUpperCase(), args: rest, text: "" })
    current = ""
  }
  for (const instruction of result)
    instruction.text = [instruction.keyword, ...instruction.args].join(" ")
  return result
}

const copyFlags = new Set([
  "chown",
  "chmod",
  "link",
  "parents",
  "exclude",
  "checksum",
  "keep-git-dir",
  "unpack",
])

// The build context paths that the target stage reads: { sources, unreadable }.
// A source is relative to the repository root, cut before its first glob
// character. An instruction that the parser does not understand, or that
// reads from outside the repository (a URL, a variable), is unreadable.
function dockerfileSources(text, { context = ".", target } = {}) {
  const stages = []
  const unreadable = []
  if (/^#\s*escape\s*=/im.test(text)) unreadable.push("# escape directive")
  const stageOf = (reference) => {
    const name = reference.toLowerCase()
    const index = /^\d+$/.test(name)
      ? Number(name)
      : stages.findIndex((stage) => stage.name === name)
    return index >= 0 && index < stages.length ? index : undefined
  }
  const source = (stage, path, instruction) => {
    if (/\$|^[a-z][a-z0-9+.-]*:\/\/|^git@/i.test(path)) {
      stage.unreadable.push(instruction.text)
      return
    }
    let literal = path.split(/[*?[]/)[0].replace(/^(\.?\/)+/, "")
    literal = literal === "." ? "" : literal.replace(/\/+$/, "")
    stage.sources.push(
      context === "." ? literal : literal ? `${context}/${literal}` : context,
    )
  }
  for (const instruction of instructions(text)) {
    const { keyword, args } = instruction
    if (keyword === "FROM") {
      const words = args.filter((word) => !word.startsWith("--"))
      const stage = {
        name: words[1]?.toLowerCase() === "as" ? words[2]?.toLowerCase() : "",
        needs: [],
        sources: [],
        unreadable: [],
      }
      if (!words[0] || words[0].includes("$"))
        stage.unreadable.push(instruction.text)
      // A stage name, not an image. FROM takes no stage number.
      const base = stages.findIndex(({ name }) => name === words[0]?.toLowerCase())
      if (base >= 0) stage.needs.push(base)
      stages.push(stage)
      continue
    }
    const stage = stages.at(-1)
    if (!stage) continue
    if (keyword === "COPY" || keyword === "ADD") {
      if (args.join(" ").includes("<<")) {
        stage.unreadable.push(instruction.text)
        continue
      }
      let from
      let index = 0
      let readable = true
      for (; args[index]?.startsWith("--"); index += 1) {
        const [flag, value] = args[index].slice(2).split(/=(.*)/s)
        if (flag === "from") from = value
        else if (!copyFlags.has(flag)) readable = false
      }
      let words = args.slice(index)
      if (words.join(" ").startsWith("[")) {
        try {
          words = JSON.parse(words.join(" "))
        } catch {
          readable = false
        }
      }
      if (!readable || words.length < 2) {
        stage.unreadable.push(instruction.text)
        continue
      }
      if (from !== undefined) {
        const needed = stageOf(from)
        if (needed !== undefined) stage.needs.push(needed)
        else if (from.includes("$")) stage.unreadable.push(instruction.text)
        continue
      }
      for (const path of words.slice(0, -1)) source(stage, path, instruction)
      continue
    }
    if (keyword === "RUN") {
      if (args.join(" ").includes("<<")) {
        stage.unreadable.push(instruction.text)
        continue
      }
      for (const word of args) {
        if (!word.startsWith("--")) break
        if (!word.startsWith("--mount=")) continue
        const options = Object.fromEntries(
          word
            .slice("--mount=".length)
            .split(",")
            .map((option) => option.split(/=(.*)/s)),
        )
        const from = options.from
        if (from !== undefined) {
          const needed = stageOf(from)
          if (needed !== undefined) stage.needs.push(needed)
          else if (from.includes("$")) stage.unreadable.push(instruction.text)
        } else if ((options.type ?? "bind") === "bind") {
          source(stage, options.source ?? options.src ?? ".", instruction)
        }
      }
    }
  }
  const last = stages.length - 1
  const start = target === undefined ? last : stageOf(target)
  if (start === undefined) return { sources: [], unreadable: [`target ${target}`] }
  const reached = new Set()
  const visit = (index) => {
    if (reached.has(index)) return
    reached.add(index)
    for (const needed of stages[index].needs) visit(needed)
  }
  visit(start)
  const sources = []
  for (const [index, stage] of stages.entries()) {
    if (!reached.has(index)) continue
    sources.push(...stage.sources)
    unreadable.push(...stage.unreadable)
  }
  return { sources, unreadable }
}

/** The paths that the image's Dockerfile copies and its inputs do not cover. */
export function uncoveredSources(root, image) {
  const { sources, unreadable } = dockerfileSources(
    readFileSync(join(root, image.dockerfile), "utf8"),
    image,
  )
  const inputs = inputsOf(image)
  const uncovered = sources.filter((path) => !covers(inputs, path))
  return [...new Set([...uncovered, ...unreadable])]
}

async function github(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
    },
  })
  if (!response.ok)
    throw new Error(`GitHub API ${path}: HTTP ${response.status}`)
  return response.json()
}

// The digest that the base run published for each image: the one
// `deploy-image` notice of its successful Publish job. A digest that is
// missing or not valid is a reason to build.
async function baseDigests({ repo, run, token }) {
  const { jobs } = await github(
    `/repos/${repo}/actions/runs/${run}/jobs?filter=latest&per_page=100`,
    token,
  )
  const digests = {}
  for (const { image } of images) {
    const job = jobs.find(
      ({ name, conclusion }) =>
        name === `Publish image (${image})` && conclusion === "success",
    )
    if (!job) {
      digests[image] = { reason: "the base run has no successful Publish job" }
      continue
    }
    const notices = (
      await github(
        `/repos/${repo}/check-runs/${job.id}/annotations?per_page=100`,
        token,
      )
    ).filter(
      ({ annotation_level, title }) =>
        annotation_level === "notice" && title === "deploy-image",
    )
    const match =
      notices.length === 1 &&
      new RegExp(`^${image} (sha256:[0-9a-f]{64})$`).exec(notices[0].message)
    digests[image] = match
      ? { digest: match[1] }
      : {
          reason: `the base Publish job has ${notices.length} deploy-image notices, not one valid notice`,
        }
  }
  return digests
}

const entry = ({ inputs, ...matrix }) => matrix

/**
 * Which images this run builds, and the digest of the base run for each
 * other image: `{ build: [matrix entry], reuse: { image: digest },
 * reasons: { image: text } }`.
 */
export async function planImages({ root, event, repo, runId, token }) {
  const everything = (reason) => ({
    build: images.map(entry),
    reuse: {},
    reasons: Object.fromEntries(images.map(({ image }) => [image, reason])),
  })
  if (event !== "push") return everything(`a ${event} run builds every image`)
  let base
  let digests
  try {
    const { workflow_runs: runs } = await github(
      `/repos/${repo}/actions/workflows/deploy.yaml/runs?branch=main&event=push&status=success&per_page=10`,
      token,
    )
    base = runs.find(({ id }) => String(id) !== String(runId))
    if (!base) return everything("no earlier successful Deploy run on main")
    if (!/^[0-9a-f]{40}$/.test(base.head_sha))
      return everything("the base run has no commit")
    try {
      execFileSync(
        "git",
        ["merge-base", "--is-ancestor", base.head_sha, "HEAD"],
        { cwd: root, stdio: "ignore" },
      )
    } catch {
      return everything(
        `the base commit ${base.head_sha} is not in the history of HEAD`,
      )
    }
    digests = await baseDigests({ repo, run: base.id, token })
  } catch (error) {
    return everything(`no base: ${error.message}`)
  }
  const changed = changedFiles(root, base.head_sha).map(({ path }) => path)
  const global = changed.find((path) => everyImage.includes(path))
  if (global) return everything(`${global} changed`)
  const result = { build: [], reuse: {}, reasons: {} }
  const short = base.head_sha.slice(0, 7)
  for (const image of images) {
    const uncovered = uncoveredSources(root, image)
    const touched = changed.find((path) => covers(inputsOf(image), path))
    const { digest, reason } = digests[image.image]
    const why = uncovered.length
      ? `its Dockerfile reads paths that its inputs do not cover: ${uncovered.join(", ")}`
      : touched
        ? `${touched} changed since ${short}`
        : reason
    if (why) {
      result.build.push(entry(image))
      result.reasons[image.image] = why
    } else {
      result.reuse[image.image] = digest
      result.reasons[image.image] =
        `no input changed since ${short}: reuses ${digest}`
    }
  }
  return result
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const env = process.env
  const result = await planImages({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    event: env.GITHUB_EVENT_NAME,
    repo: env.GITHUB_REPOSITORY,
    runId: env.GITHUB_RUN_ID,
    token: env.GH_TOKEN,
  })
  const lines = [
    `build=${JSON.stringify(result.build)}`,
    `reuse=${JSON.stringify(result.reuse)}`,
    `images=${JSON.stringify(images.map(entry))}`,
  ]
  const summary = [
    "| Image | Plan |",
    "| --- | --- |",
    ...images.map(
      ({ image }) =>
        `| ${image} | ${image in result.reuse ? "reuse" : "build"}: ${result.reasons[image]} |`,
    ),
  ]
  console.log(summary.join("\n"))
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`)
  else console.log(lines.join("\n"))
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`)
}
