import { spawnSync } from "node:child_process"

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
