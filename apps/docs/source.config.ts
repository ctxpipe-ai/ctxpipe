import {
  defineConfig,
  defineDocs,
  frontmatterSchema,
} from "fumadocs-mdx/config"

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    // Keeps `draft` (and other keys) in the page data. `draft: true` keeps a
    // page off the site (lib/source.ts).
    schema: frontmatterSchema.loose(),
    // For getText("processed"): the Markdown copies and llms-full.txt.
    postprocess: { includeProcessedMarkdown: true },
  },
})

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      themes: {
        light: "github-light",
        dark: "github-dark-dimmed",
      },
    },
  },
})
