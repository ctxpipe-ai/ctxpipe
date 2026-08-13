# Docs (`apps/docs`) – agent instructions

When working in **`apps/docs`**, follow these instructions in addition to the root [AGENTS.md](../../AGENTS.md).

- **Stack**: Fumadocs on **Next.js 15** (`fumadocs-ui` / `fumadocs-core` / `fumadocs-mdx`). MDX content lives under [`content/docs/`](content/docs/); app routes under [`app/`](app/).
- **Local dev**: From the **repo root**, run **`pnpm dev:docs`** (or `pnpm --filter @ctxpipe/docs dev`). Serves on **http://localhost:3003**. Root **`pnpm dev`** does **not** start docs.
- **Site layout**: App is at the site root (`/`); Fumadocs base path for doc URLs remains **`/docs`**. Deploys to **docs.ctxpipe.ai**.
- **Content edits**: Prefer updating MDX under `content/docs/` (and colocated `meta.json` nav). Keep redirects in [`next.config.ts`](next.config.ts) when renaming public doc paths.
- **Do not** treat this app as the product UI — that is [`apps/ui`](../ui/).
