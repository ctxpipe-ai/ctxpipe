import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { fileURLToPath, pathToFileURL } from "node:url"

// Whether this push to main publishes a snapshot of @ctxpipe/aws-cdk to the
// npm dist-tag `canary` (deploy.yaml, job prerelease).
//
// A canary publishes when HEAD has a pending changeset that releases
// @ctxpipe/aws-cdk (patch, minor or major) and that the current canary does
// not have. The package pins its images to the commit that built it
// (PINNED_SERVICE_IMAGE_TAG), so the canary tarball names that commit: a
// pending changeset of HEAD that is not in the tree of that commit, with the
// same text, is new. The comparison is with npm, not with the commit before
// this push. Thus a run that the deploy-main group cancelled, or a publish
// that failed, loses no canary: its changeset is still pending in the next
// run. A changeset that the version PR consumed is in the stable release, so
// it publishes no canary. An empty changeset, or a changeset of another
// package only, publishes nothing. When npm has no canary, or its commit is
// not in this clone (the canary of 2026-09 is from a commit that is not on
// main), each pending changeset is new. An npm error fails the plan: the next
// run tries again.
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

/** The changesets of `commit`: path to blob id. Empty for an unknown commit. */
function changesets(root, commit) {
  let tree = ""
  try {
    tree = git(root, "ls-tree", commit, "--", ".changeset/")
  } catch {
    return new Map()
  }
  return new Map(
    tree
      .split("\n")
      .map((line) => /^\d+ blob ([0-9a-f]+)\t(\.changeset\/[^/]+\.md)$/.exec(line))
      .filter(Boolean)
      .map(([, blob, path]) => [path, blob]),
  )
}

/** `{ publish, reason }` for the checkout `root` against npm at `registry`. */
export async function canaryPlan({
  root,
  registry = "https://registry.npmjs.org",
}) {
  const pending = [...changesets(root, "HEAD")].filter(([, blob]) =>
    releasesAwsCdk(git(root, "cat-file", "blob", blob)),
  )
  if (pending.length === 0)
    return {
      publish: false,
      reason: "no pending changeset releases @ctxpipe/aws-cdk",
    }
  const pin = await canaryCommit(registry)
  const inCanary = pin ? changesets(root, pin) : new Map()
  const added = pending.find(([path, blob]) => inCanary.get(path) !== blob)
  if (!added)
    return {
      publish: false,
      reason: `the canary of ${pin} has each pending changeset of @ctxpipe/aws-cdk`,
    }
  return {
    publish: true,
    reason: `${added[0]} releases @ctxpipe/aws-cdk, and the canary${pin ? ` of ${pin}` : ""} does not have it`,
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
