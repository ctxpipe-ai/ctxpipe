---
"@ctxpipe/aws-cdk": patch
---

improvement: Knowledge search: a Markdown section that holds only its heading line now joins the next section, and in a section over the size cap a paragraph of only headings stays with the next paragraph. Thus no search hit shows only a heading. When hydrate or the knowledge plane projects a unit again, it embeds again only the changed chunks of that unit: the chunk after each heading-only section, and the chunks of a long section whose heading was its own chunk. A heading-only chunk at the end of a unit is deleted. MCP read-tool spans now record the argument names, the query length, the result count, and the top score, but no query text.
