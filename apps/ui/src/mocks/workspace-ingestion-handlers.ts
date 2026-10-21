import { HttpResponse, http } from "msw"
import type { IngestionItem } from "@/features/workspaces/ingestion"

function pathnameOf(request: Request) {
  return new URL(request.url).pathname
}

/** A run that started `minutesAgo` before now. */
export function ingestionItemFixture(
  overrides: Partial<IngestionItem> & { minutesAgo?: number } = {},
): IngestionItem {
  const { minutesAgo = 4, ...rest } = overrides
  return {
    id: "run_web",
    kind: "repository",
    name: "acme/web",
    stage: "ingesting",
    progress: { done: 3, total: 8, unit: "shards" },
    startedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    ...rest,
  }
}

/**
 * The org read (the sidebar) and the Workspace read (settings) of the
 * ingestion work. `state` is a map of Workspace slug to items, or a function
 * that a story calls on each request, so the state can change over time.
 */
export function workspaceIngestionHandlers(
  state:
    | Record<string, IngestionItem[]>
    | (() => Record<string, IngestionItem[]>),
  /** Each answered request path, so a play can wait for the read. */
  answered?: string[],
) {
  const read = () => (typeof state === "function" ? state() : state)
  return [
    http.get(
      ({ request }) => pathnameOf(request).endsWith("/workspace-ingestion"),
      ({ request }) => {
        answered?.push(pathnameOf(request))
        return HttpResponse.json({
          workspaces: Object.entries(read())
            .filter(([, items]) => items.length > 0)
            .map(([workspaceSlug, items]) => ({ workspaceSlug, items })),
        })
      },
    ),
    http.get(
      ({ request }) =>
        /\/workspaces\/[^/]+\/ingestion$/.test(pathnameOf(request)),
      ({ request }) => {
        answered?.push(pathnameOf(request))
        const slug = pathnameOf(request).split("/").at(-2) ?? ""
        return HttpResponse.json({ items: read()[slug] ?? [] })
      },
    ),
  ]
}
