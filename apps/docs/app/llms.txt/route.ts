import type * as PageTree from "fumadocs-core/page-tree"

import { docsOrigin, source } from "@/lib/source"

export const revalidate = false

/**
 * The docs index for agents (llmstxt.org), in sidebar order. The marketing
 * site's llms.txt owns the positioning, the audience, and the comparisons, so
 * this file links to it instead of repeating them.
 */
export function GET() {
  const pages = new Map(source.getPages().map((page) => [page.url, page]))
  const line = (url: string) => {
    const page = pages.get(url)
    if (!page) return []
    const { title, description } = page.data
    return [
      `- [${title}](${docsOrigin}${url}.mdx)${description ? `: ${description}` : ""}`,
    ]
  }
  const lines = (nodes: PageTree.Node[]): string[] =>
    nodes.flatMap((node) => {
      if (node.type === "page") return line(node.url)
      if (node.type === "folder")
        return [
          ...(node.index ? line(node.index.url) : []),
          ...lines(node.children),
        ]
      return []
    })

  const sections = source.pageTree.children.flatMap((node) =>
    node.type === "folder" ? [`## ${node.name}`, "", ...lines([node]), ""] : [],
  )

  const text = [
    "# ctxpipe docs",
    "",
    "> ctxpipe turns your code, tickets, and docs into one organized, current, inspectable repo that your whole agent fleet reads over MCP. Open source.",
    "",
    "These docs tell you how to set up ctxpipe, connect your tools and your coding agents, and self-host it. Each link opens the page as Markdown. For what ctxpipe is, who it is for, and how it compares, read https://www.ctxpipe.ai/llms.txt.",
    "",
    ...sections,
    "## Optional",
    "",
    `- [All docs in one file](${docsOrigin}/llms-full.txt)`,
    "- [ctxpipe overview](https://www.ctxpipe.ai/llms.txt): what ctxpipe is, who it is for, and how it compares",
    "- [Source code (MIT)](https://github.com/ctxpipe-ai/ctxpipe)",
    "",
  ].join("\n")

  return new Response(text, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}
