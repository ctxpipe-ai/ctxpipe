import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, parse } from "node:path"
import { log } from "../../observability/logger.js"

/**
 * The cache layout of this release: one shared clone for each repository,
 * with a worktree for each checkout, and no Workspace checkouts.
 */
const CACHE_LAYOUT = 2

/**
 * Empties the repository cache and the Zoekt index once, when the layout
 * file is missing or names an older layout, and then writes the layout file.
 * It deletes only the entries in `dirs` (the old layout file too), never a
 * directory itself or a path outside them. The backend indexes each published repository again (the
 * hourly checkout collection finds the missing checkout). A crash before the
 * layout file is written empties the directories again on the next start.
 */
export async function resetCacheForLayout(input: {
  markerPath: string
  dirs: string[]
}): Promise<{ reset: boolean }> {
  const marker = await readFile(input.markerPath, "utf8").catch(() => "")
  if (Number.parseInt(marker.trim(), 10) >= CACHE_LAYOUT)
    return { reset: false }
  for (const dir of input.dirs)
    if (!isAbsolute(dir) || dir === parse(dir).root)
      throw new Error(
        `Cache directory must be an absolute non-root path: ${dir}`,
      )
  const cleared: Record<string, number> = {}
  for (const dir of input.dirs) {
    const names = await readdir(dir).catch(() => [] as string[])
    // `rm` deletes a symlink, not its target.
    for (const name of names)
      await rm(join(dir, name), { recursive: true, force: true })
    cleared[dir] = names.length
  }
  await mkdir(dirname(input.markerPath), { recursive: true })
  await writeFile(input.markerPath, `${CACHE_LAYOUT}\n`)
  log.info({
    step: "codesearch.cache_layout_reset",
    message: `Emptied the cache for layout ${CACHE_LAYOUT}: ${Object.entries(
      cleared,
    )
      .map(([dir, count]) => `${count} entries in ${dir}`)
      .join(", ")}`,
    layout: CACHE_LAYOUT,
  })
  return { reset: true }
}
