import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { fileURLToPath, pathToFileURL } from "node:url"

// Whether this push to main publishes a snapshot of @ctxpipe/aws-cdk to the
// npm dist-tag `canary` (deploy.yaml, job prerelease).
//
// The comparison is with the commit of the canary that npm serves now, not
// with the commit before this push. The package pins its images to the commit
// that built it (PINNED_SERVICE_IMAGE_TAG), so the canary tarball names that
// commit. Thus a run that the deploy-main group cancelled, or a publish that
// failed, loses no canary: the next run finds the changeset too.
//
// A canary publishes when a commit after the canary commit adds a changeset
// that releases @ctxpipe/aws-cdk (patch, minor or major), also when a later
// version commit deleted it. A canary publishes too when npm has no canary,
// or when its commit is not in the history of HEAD. An empty changeset, or a
// changeset of another package only, publishes nothing. An npm error fails
// the plan: the next run tries again.
//
// Usage (deploy.yaml, job canary_plan): node scripts/ci/canary-plan.mjs
// It writes `publish` (true or false) to $GITHUB_OUTPUT.

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
}

async function get(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response
}

/** The commit that the current canary of @ctxpipe/aws-cdk pins, if any. */
async function canaryCommit(registry) {
  const meta = await (
    await get(`${registry}/@ctxpipe%2faws-cdk`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
    })
  ).json()
  const version = meta["dist-tags"]?.canary
  if (!version) return undefined
  const tarball = gunzipSync(
    Buffer.from(
      await (
        await get(`${registry}/@ctxpipe/aws-cdk/-/aws-cdk-${version}.tgz`)
      ).arrayBuffer(),
    ),
  )
  return /PINNED_SERVICE_IMAGE_TAG = "([0-9a-f]{40})"/.exec(
    tarball.toString("latin1"),
  )?.[1]
}

/** Whether the front matter of a changeset releases @ctxpipe/aws-cdk. */
function releasesAwsCdk(changeset) {
  const front = /^---\r?\n([\s\S]*?)^---/m.exec(changeset)?.[1] ?? ""
  return /^\s*(["']?)@ctxpipe\/aws-cdk\1\s*:\s*(patch|minor|major)\s*$/m.test(
    front,
  )
}

/** `{ publish, reason }` for the checkout `root` against npm at `registry`. */
export async function canaryPlan({
  root,
  registry = "https://registry.npmjs.org",
}) {
  const pin = await canaryCommit(registry)
  if (!pin)
    return { publish: true, reason: "npm has no canary with a pinned commit" }
  try {
    git(root, "merge-base", "--is-ancestor", pin, "HEAD")
  } catch {
    return {
      publish: true,
      reason: `the canary commit ${pin} is not in the history of HEAD`,
    }
  }
  // Each commit after the canary commit, newest first, with the changesets
  // that it adds.
  let commit
  for (const line of git(
    root,
    "log",
    "--diff-filter=A",
    "--name-only",
    "--format=commit %H",
    `${pin}..HEAD`,
    "--",
    ".changeset/*.md",
  ).split("\n")) {
    if (line.startsWith("commit ")) commit = line.slice(7)
    else if (line && releasesAwsCdk(git(root, "show", `${commit}:${line}`)))
      return {
        publish: true,
        reason: `${line} (${commit.slice(0, 9)}) releases @ctxpipe/aws-cdk after the canary commit ${pin}`,
      }
  }
  return {
    publish: false,
    reason: `no changeset releases @ctxpipe/aws-cdk after the canary commit ${pin}`,
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { publish, reason } = await canaryPlan({
    root: fileURLToPath(new URL("../../", import.meta.url)),
  })
  console.log(`${publish ? "Publish" : "No"} canary: ${reason}`)
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\n`)
}
