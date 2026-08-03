import { IconExternalLink } from "@tabler/icons-react"
import type { SuggestedConnectorSyncTarget } from "../types"

export const CONNECTOR_CONTEXT_REPOSITORY_NAME = "ctxpipe-context"

export function getConnectorContextRepositoryCreateUrl(
  accountSlug?: string | null,
): string {
  const params = new URLSearchParams({
    name: CONNECTOR_CONTEXT_REPOSITORY_NAME,
    description: "Shared connector context for ctxpipe",
  })
  if (accountSlug) params.set("owner", accountSlug)
  return `https://github.com/new?${params.toString()}`
}

export function ConnectorContextRepositoryGuidance({
  suggestedTarget,
}: {
  suggestedTarget?: SuggestedConnectorSyncTarget | null
}) {
  return (
    <div className="border border-teal-500/40 bg-teal-500/5 p-4">
      <div className="text-xs font-medium tracking-wide text-teal-300 uppercase">
        Shared connector context repository
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        We recommend using one GitHub repository for all ctxpipe connector
        content. Connector files remain separated under paths such as{" "}
        <code className="bg-muted px-1 py-0.5 text-[11px]">notion/</code> and{" "}
        <code className="bg-muted px-1 py-0.5 text-[11px]">confluence/</code>.
      </p>
      {suggestedTarget ? (
        <div className="mt-3 border-t border-teal-500/20 pt-3">
          <div className="text-xs text-muted-foreground">
            Recommended existing repository
          </div>
          <div className="mt-1 text-sm font-medium text-foreground">
            {suggestedTarget.repositoryName}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Already used by{" "}
            {suggestedTarget.usedBy
              .map((source) =>
                source === "confluence" ? "Confluence" : "Notion",
              )
              .join(" and ")}
            .
          </p>
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          For your first connector, create{" "}
          <code className="bg-muted px-1 py-0.5 text-[11px]">
            {CONNECTOR_CONTEXT_REPOSITORY_NAME}
          </code>{" "}
          once, then reuse it for future connectors. You can choose another name
          if your team has its own convention.
        </p>
      )}
      <a
        href="https://docs.ctxpipe.ai/docs/connections/context-repository"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-flex items-center gap-1 text-sm text-teal-400 hover:text-teal-300"
      >
        About connector context repositories
        <IconExternalLink className="size-3.5" aria-hidden />
      </a>
    </div>
  )
}
