import { docs } from "@/.source"
import { loader, type VirtualFile } from "fumadocs-core/source"

const mdxSource = docs.toFumadocsSource()

// fumadocs-mdx runtime uses `files` as `() => VirtualFile[]`; types may declare `files` as the array.
const rawFiles = mdxSource.files as unknown
const files: VirtualFile[] =
  typeof rawFiles === "function"
    ? (rawFiles as () => VirtualFile[])()
    : (rawFiles as VirtualFile[])

export const source = loader(
  { ...mdxSource, files },
  { baseUrl: "/docs" },
)
