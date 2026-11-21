import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs"
import { dirname, join, posix } from "node:path"
import { fileURLToPath } from "node:url"

// The UI production build bundles some files outside apps/ui. Two users read
// this one list: the inputs of the check build:image-ui (projects.mjs), and
// the `ui-imports` stage of apps/ui/Dockerfile, which copies only these
// files into the build. Thus a backend change outside the list does not
// rebuild the UI bundle.
//
// Usage: node scripts/checks/ui-bundled-imports.mjs <out>
// It copies each listed file to <out>/<path>.

const root = fileURLToPath(new URL("../../", import.meta.url))

// The files outside apps/ui that the UI production build bundles: the value
// imports of each bundled UI file (alias `backend/*` or a relative path), and
// then the value imports of those files, until no new file is found. The
// build erases an `import type`, and it bundles no test or story. A package
// import is not a file of the repository; the lockfile covers it.
export const uiBundledImports = () => {
  const queue = readdirSync(join(root, "apps/ui/src"), { recursive: true })
    .map((file) => posix.join("apps/ui/src", file.split("\\").join("/")))
    .filter(
      (file) =>
        /\.(ts|tsx)$/.test(file) && !/\.(test|stories)\.tsx?$/.test(file),
    )
  const found = new Set()
  const isFile = (path) =>
    existsSync(join(root, path)) && statSync(join(root, path)).isFile()
  while (queue.length > 0) {
    const file = queue.pop()
    const text = readFileSync(join(root, file), "utf8")
    for (const [, type, specifier] of text.matchAll(
      /\b(?:import|export)(?:\s+(type\s+)?(?:[^;'"]*?\sfrom\s+)?|\s*\(\s*)["']([^"']+)["']/g,
    )) {
      if (type) continue
      const base =
        specifier.startsWith("backend/") && file.startsWith("apps/ui/")
          ? posix.join("apps/backend/src", specifier.slice("backend/".length))
          : specifier.startsWith(".")
            ? posix.join(dirname(file), specifier)
            : ""
      if (!base || base.startsWith("apps/ui/")) continue
      const resolved = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}/index.ts`,
        base.replace(/\.js$/, ".ts"),
        base.replace(/\.js$/, ".tsx"),
      ].find(isFile)
      if (!resolved) throw new Error(`${file}: cannot resolve ${specifier}`)
      if (found.has(resolved)) continue
      found.add(resolved)
      if (/\.(ts|tsx|js|mjs)$/.test(resolved)) queue.push(resolved)
    }
  }
  return [...found].sort()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [out] = process.argv.slice(2)
  if (!out) throw new Error("usage: ui-bundled-imports.mjs <out>")
  for (const file of uiBundledImports()) {
    mkdirSync(join(out, dirname(file)), { recursive: true })
    cpSync(join(root, file), join(out, file))
  }
}
