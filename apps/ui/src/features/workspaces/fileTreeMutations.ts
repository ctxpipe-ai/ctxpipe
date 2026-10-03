export function parentDirectory(path: string): string | null {
  const index = path.lastIndexOf("/")
  if (index <= 0) return null
  return path.slice(0, index)
}

export function fileBasename(path: string): string {
  return path.split("/").pop() ?? path
}

export function joinFileName(
  directory: string | null,
  name: string,
): string | null {
  const cleaned = name.trim().replaceAll("\\", "/")
  if (
    !cleaned ||
    cleaned.includes("/") ||
    cleaned === "." ||
    cleaned === ".."
  ) {
    return null
  }
  return directory ? `${directory}/${cleaned}` : cleaned
}

export function destinationAfterMove(
  from: string,
  toDirectory: string | null,
): string | null {
  return joinFileName(toDirectory, fileBasename(from))
}

export function isMoveIntoSelf(
  from: string,
  toDirectory: string | null,
): boolean {
  if (toDirectory == null) return false
  return toDirectory === from || toDirectory.startsWith(`${from}/`)
}

export function optimisticPathsAfterJob(
  paths: readonly string[],
  input:
    | { op: "create"; path: string }
    | { op: "delete"; path: string }
    | { op: "rename"; from: string; to: string }
    | { op: "move"; from: string; toDirectory: string | null },
): string[] {
  if (input.op === "create") {
    return paths.includes(input.path) ? [...paths] : [...paths, input.path]
  }
  if (input.op === "delete") {
    const prefix = `${input.path}/`
    return paths.filter(
      (path) => path !== input.path && !path.startsWith(prefix),
    )
  }
  const to =
    input.op === "rename"
      ? input.to
      : destinationAfterMove(input.from, input.toDirectory)
  if (!to) return [...paths]
  const prefix = `${input.from}/`
  return paths.map((path) => {
    if (path === input.from) return to
    if (path.startsWith(prefix)) return `${to}/${path.slice(prefix.length)}`
    return path
  })
}
