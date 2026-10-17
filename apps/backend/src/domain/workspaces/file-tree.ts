export type FileTreeNode = {
  name: string
  path: string
  children?: FileTreeNode[]
}

export function fileTreeFromPaths(paths: readonly string[]): FileTreeNode[] {
  const root: FileTreeNode[] = []
  for (const path of [...paths].sort()) {
    const parts = path.split("/").filter(Boolean)
    let level = root
    let prefix = ""
    for (const [index, part] of parts.entries()) {
      prefix = prefix ? `${prefix}/${part}` : part
      const existing = level.find((node) => node.name === part)
      if (existing) {
        if (index < parts.length - 1) {
          existing.children ??= []
          level = existing.children
        }
        continue
      }
      const node: FileTreeNode =
        index === parts.length - 1
          ? { name: part, path: prefix }
          : { name: part, path: prefix, children: [] }
      level.push(node)
      if (node.children) level = node.children
    }
  }
  return root
}
