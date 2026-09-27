import { docs } from "@/.source"
import { loader, type VirtualFile } from "fumadocs-core/source"

const mdxSource = docs.toFumadocsSource()

// fumadocs-mdx runtime uses `files` as `() => VirtualFile[]`; types may declare `files` as the array.
const rawFiles = mdxSource.files as unknown
const allFiles: VirtualFile[] =
  typeof rawFiles === "function"
    ? (rawFiles as () => VirtualFile[])()
    : (rawFiles as VirtualFile[])

/** Unpublished until the hosted Claude plugin is available in production. */
const UNPUBLISHED_PAGE_PATHS = ["claude-plugin.mdx"]

const files = allFiles.filter(
  (file) =>
    !UNPUBLISHED_PAGE_PATHS.some(
      (name) => file.path === name || file.path.endsWith(`/${name}`),
    ),
)

export const source = loader(
  { ...mdxSource, files },
  { baseUrl: "/docs" },
)
