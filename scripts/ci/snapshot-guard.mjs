import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// Stops a snapshot prerelease that would publish a stable version
// (root package.json, script ci:prerelease, after `changeset version
// --snapshot`). `changeset publish --tag <tag>` publishes each public package
// of packages/ whose version npm does not have. A package without a pending
// changeset keeps its stable version, so a stable version that npm does not
// have yet (a version PR before its publish) would go to npm under the
// snapshot tag, and the stable release could not publish it again.
//
// Usage: SNAPSHOT_TAG=<tag> node scripts/ci/snapshot-guard.mjs
// It fails with each such name@version.

/**
 * The `name@version` of each public package of `root`/packages that is not a
 * snapshot of `tag` and that npm at `registry` does not have.
 */
export async function stableVersionsToPublish({
  root,
  tag,
  registry = "https://registry.npmjs.org",
}) {
  const snapshot = new RegExp(`^0\\.0\\.0-${tag}-\\d{14}$`)
  const found = []
  for (const folder of readdirSync(join(root, "packages"))) {
    const file = join(root, "packages", folder, "package.json")
    if (!existsSync(file)) continue
    const { name, version, private: hidden } = JSON.parse(
      readFileSync(file, "utf8"),
    )
    if (hidden || snapshot.test(version)) continue
    const url = `${registry}/${name.replace("/", "%2f")}/${version}`
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (response.status === 404) found.push(`${name}@${version}`)
    else if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  }
  return found
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const tag = process.env.SNAPSHOT_TAG
  if (!tag) throw new Error("SNAPSHOT_TAG is not set")
  const found = await stableVersionsToPublish({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    tag,
  })
  if (found.length > 0) {
    console.error(
      `::error::The snapshot would publish ${found.join(", ")} under the dist-tag ${tag}. Publish the stable release first.`,
    )
    process.exit(1)
  }
}
