# Supermemory MCP Content Model

Sources: https://supermemory.ai/mcp/, https://github.com/supermemoryai/supermemory-mcp, https://github.com/supermemoryai/supermemory/tree/main/apps/mcp, https://supermemory.ai/blog/the-ux-and-technicalities-of-awesome-mcps/

## What It Stores

Supermemory MCP exposes the Supermemory product's memory backend through MCP. Public pages frame it as universal memories across assistants.

Likely stored content:

- user memories;
- facts;
- notes/bookmarks/content snippets depending on broader Supermemory product usage;
- memories retrievable by MCP clients.

Exact backend schema is product-managed and was not visible in the MCP docs.

## Semantics / Types It Looks For

The MCP page is generic: it makes "your memories" available to clients. It is not coding-specific and does not expose a public typed memory ontology in the pages reviewed.

Likely themes:

- personal facts;
- preferences;
- saved context;
- web/content memories;
- cross-client assistant context.

## Extraction Prompt

No MCP-specific extraction prompt was found. The MCP server appears to pass store/retrieve operations to Supermemory's API/product.

Links:

- MCP page: https://supermemory.ai/mcp/
- MCP repo: https://github.com/supermemoryai/supermemory-mcp
- monorepo MCP app: https://github.com/supermemoryai/supermemory/tree/main/apps/mcp

## How It Manages Memory Soup

Publicly visible controls are mostly product-level:

- MCP tool surface limits how clients interact with memory;
- universal backend avoids fragmented per-tool memories;
- product likely manages indexing/search centrally.

Unknown:

- extraction criteria;
- deduplication;
- stale memory decay;
- coding scope;
- provenance;
- export/delete model at the record level.

## Notes For ctxpipe

Supermemory MCP is more useful for MCP UX lessons than local content modeling. For ctxpipe, cloud/product-managed generic memory is not enough without repo-local scoping and inspectable records.

