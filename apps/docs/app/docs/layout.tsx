import type { ReactNode } from "react"
import type * as PageTree from "fumadocs-core/page-tree"
import { source } from "@/lib/source"
import { DocsModeLayout } from "./components/docs-mode-layout"

function findRootFolder(tree: PageTree.Root, name: string) {
  return tree.children.find(
    (node): node is PageTree.Folder =>
      node.type === "folder" && node.root === true && node.name === name,
  )
}

function rootOnlyTree(tree: PageTree.Root, name: string): PageTree.Root {
  const root = findRootFolder(tree, name)
  const id = name.toLowerCase().replace(/\s+/g, "-")

  return {
    ...tree,
    $id: `${tree.$id ?? "root"}-${id}`,
    name: root?.name ?? tree.name,
    children: root?.children ?? tree.children,
    fallback: undefined,
  }
}

const docsTree = rootOnlyTree(source.pageTree, "Docs")
const selfHostingTree = rootOnlyTree(source.pageTree, "Self hosting")

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsModeLayout
      docsTree={docsTree}
      selfHostingTree={selfHostingTree}
    >
      {children}
    </DocsModeLayout>
  )
}
