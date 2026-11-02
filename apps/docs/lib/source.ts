import { type InferPageType, loader } from "fumadocs-core/source"

import { docs } from "@/.source"

const mdxSource = docs.toFumadocsSource()

/** A page with `draft: true` in its front matter is not on the site. */
const files = mdxSource.files.filter(
  (file) => !(file.type === "page" && file.data.draft === true),
)

export const source = loader({ ...mdxSource, files }, { baseUrl: "/docs" })

export const docsOrigin = "https://docs.ctxpipe.ai"

/** One page as Markdown for agents: its title, its URL, and its processed MDX. */
export async function getLLMText(page: InferPageType<typeof source>) {
  const processed = await page.data.getText("processed")
  return `# ${page.data.title} (${docsOrigin}${page.url})\n\n${processed}`
}
