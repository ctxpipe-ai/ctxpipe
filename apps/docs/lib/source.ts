import { type InferPageType, loader } from "fumadocs-core/source"

import { docs } from "@/.source"

const mdxSource = docs.toFumadocsSource()

/** Unpublished until the hosted Claude plugin is available in production. */
const UNPUBLISHED_PAGE_PATHS = ["claude-plugin.mdx"]

const files = mdxSource.files.filter(
  (file) =>
    !UNPUBLISHED_PAGE_PATHS.some(
      (name) => file.path === name || file.path.endsWith(`/${name}`),
    ),
)

export const source = loader({ ...mdxSource, files }, { baseUrl: "/docs" })

export const docsOrigin = "https://docs.ctxpipe.ai"

/** One page as Markdown for agents: its title, its URL, and its processed MDX. */
export async function getLLMText(page: InferPageType<typeof source>) {
  const processed = await page.data.getText("processed")
  return `# ${page.data.title} (${docsOrigin}${page.url})\n\n${processed}`
}
