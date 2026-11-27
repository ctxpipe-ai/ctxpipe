import { spawnSync } from "node:child_process"
import {
  accessSync,
  constants,
  existsSync,
  realpathSync,
  statSync,
} from "node:fs"
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path"

export function commandExists(command: string): boolean {
  if (!command) return false
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: "ignore",
  })
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    return false
  }
  return result.status === 0 || result.status === 1
}

export function openBrowser(url: string): boolean {
  const platform = process.platform
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open"
  const args = platform === "win32" ? ["/c", "start", "", url] : [url]
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "ignore",
  })
  return result.status === 0
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * PATH with no folder that a repository can control: no relative folder, no
 * `node_modules` folder (`npx` puts `node_modules/.bin` on PATH), and no
 * folder in the repository of `cwd`. The repository root is the nearest
 * folder that has `.git`, found with no command run (a planted `git` cannot
 * change it).
 */
export function trustedPath(
  cwd: string,
  path = process.env.PATH ?? "",
): string {
  let root = realpathSync(cwd)
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) {
      root = dir
      break
    }
    if (dirname(dir) === dir) break
  }
  return path
    .split(delimiter)
    .filter((dir) => {
      if (!isAbsolute(dir) || dir.split(sep).includes("node_modules")) {
        return false
      }
      if (!existsSync(dir)) return false
      const rel = relative(root, realpathSync(dir))
      return rel.startsWith("..") || isAbsolute(rel)
    })
    .join(delimiter)
}

/** The absolute path of `name` in the trusted PATH of `cwd` (see trustedPath), or null. */
export function trustedCommand(name: string, cwd: string): string | null {
  for (const dir of trustedPath(cwd).split(delimiter)) {
    const file = join(dir, name)
    try {
      accessSync(file, constants.X_OK)
      if (statSync(file).isFile()) return file
    } catch {
      // not in this folder
    }
  }
  return null
}
