import { IconExternalLink } from "@tabler/icons-react"
import { Button } from "@/components/ui/Button"
import type { SuggestedConnectorSyncTarget } from "../types"

export const CONNECTOR_CONTEXT_REPOSITORY_NAME = "ctxpipe-context"

export function isCtxpipeContextRepositoryName(name: string): boolean {
  const repo = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name
  return repo === CONNECTOR_CONTEXT_REPOSITORY_NAME
}

const SUGGESTED_TARGET_LABELS: Record<
  SuggestedConnectorSyncTarget["usedBy"][number],
  string
> = {
  confluence: "Confluence",
  notion: "Notion",
  linear: "Linear",
  slack: "Slack",
  github: "GitHub",
}

export function describeSuggestedTargetUse(
  usedBy: SuggestedConnectorSyncTarget["usedBy"],
): string {
  if (usedBy.length === 1 && usedBy[0] === "github") {
    return "Selected during GitHub setup."
  }
  const names = usedBy
    .filter((source) => source !== "github")
    .map((source) => SUGGESTED_TARGET_LABELS[source])
  if (names.length === 0) return "Selected during GitHub setup."
  return `Already used by ${names.join(" and ")}.`
}

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

const DOCS_HREF = "https://docs.ctxpipe.ai/docs/connections/context-repository"

function AboutContextRepositoryLink() {
  return (
    <a
      href={DOCS_HREF}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-3 inline-flex items-center gap-1 text-sm text-teal-400 hover:text-teal-300"
    >
      About connector context repositories
      <IconExternalLink className="size-3.5" aria-hidden />
    </a>
  )
}

export function ConnectorContextRepositoryGuidance({
  suggestedTarget,
  foundRepositoryName,
  variant = "connector",
}: {
  suggestedTarget?: SuggestedConnectorSyncTarget | null
  foundRepositoryName?: string | null
  variant?: "connector" | "onboarding"
}) {
  if (variant === "onboarding") {
    return (
      <div>
        <img
          src="/images/ctxpipe-context-repo.svg"
          alt="Developer tools clone into one ctxpipe-context repository"
          width={718}
          height={192}
          className="block h-auto w-full"
        />
        <p className="ctx-label mt-4 text-teal-400">Context repository</p>
        <p className="mt-2 text-sm text-muted-foreground">
          One GitHub repository for pull requests and later connectors. Create{" "}
          <code className="bg-muted px-1 py-0.5 text-[11px]">
            {CONNECTOR_CONTEXT_REPOSITORY_NAME}
          </code>{" "}
          once, then reuse it.
        </p>
        {foundRepositoryName ? (
          <p className="mt-2 text-sm text-muted-foreground">
            This installation includes{" "}
            <code className="bg-muted px-1 py-0.5 text-[11px]">
              {foundRepositoryName}
            </code>
            .
          </p>
        ) : null}
        <AboutContextRepositoryLink />
      </div>
    )
  }

  return (
    <div className="border border-teal-500/40 bg-teal-500/5 p-4">
      <div className="text-xs font-medium tracking-wide text-teal-300 uppercase">
        Shared connector context repository
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        We recommend using one GitHub repository for all ctxpipe connector
        content. Connector files remain separated under paths such as{" "}
        <code className="bg-muted px-1 py-0.5 text-[11px]">github/</code>,{" "}
        <code className="bg-muted px-1 py-0.5 text-[11px]">linear/</code>,{" "}
        <code className="bg-muted px-1 py-0.5 text-[11px]">notion/</code>, and{" "}
        <code className="bg-muted px-1 py-0.5 text-[11px]">slack/</code>.
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
            {describeSuggestedTargetUse(suggestedTarget.usedBy)}
          </p>
        </div>
      ) : foundRepositoryName ? (
        <p className="mt-3 text-sm text-muted-foreground">
          This installation includes{" "}
          <code className="bg-muted px-1 py-0.5 text-[11px]">
            {foundRepositoryName}
          </code>
          . ctx| will write pull-request capture and later connector content
          here when you save.
        </p>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          Create{" "}
          <code className="bg-muted px-1 py-0.5 text-[11px]">
            {CONNECTOR_CONTEXT_REPOSITORY_NAME}
          </code>{" "}
          once, then reuse it for pull-request capture and later connectors. You
          can choose another name if your team has its own convention.
        </p>
      )}
      <AboutContextRepositoryLink />
    </div>
  )
}

export function ConnectorContextRepositoryCreateSteps({
  createUrl,
  accountSlug,
  manageUrls,
  isRefreshing,
  onRefresh,
}: {
  createUrl: string
  accountSlug?: string | null
  manageUrls: readonly string[]
  isRefreshing: boolean
  onRefresh: () => void
}) {
  return (
    <div className="border border-border bg-card/30 p-4">
      <h4 className="text-sm font-medium text-foreground">
        Create your shared context repository
      </h4>
      <ol className="mt-3 space-y-3 text-sm text-muted-foreground">
        <li className="flex gap-3">
          <span className="flex size-5 shrink-0 items-center justify-center border border-border text-xs text-foreground">
            1
          </span>
          <p>
            <a
              href={createUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-teal-400 hover:text-teal-300"
            >
              Create {CONNECTOR_CONTEXT_REPOSITORY_NAME} on GitHub
              <IconExternalLink className="size-3.5" aria-hidden />
            </a>
            {accountSlug ? (
              <>
                {" "}
                under{" "}
                <code className="bg-muted px-1 py-0.5 text-[11px]">
                  {accountSlug}
                </code>
              </>
            ) : null}
            .
          </p>
        </li>
        {manageUrls.map((manageUrl, index) => (
          <li key={manageUrl} className="flex gap-3">
            <span className="flex size-5 shrink-0 items-center justify-center border border-border text-xs text-foreground">
              {index + 2}
            </span>
            <p>
              <a
                href={manageUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-teal-400 hover:text-teal-300"
              >
                Give the ctx| GitHub App access
                <IconExternalLink className="size-3.5" aria-hidden />
              </a>{" "}
              to the new repository.
            </p>
          </li>
        ))}
        <li className="flex gap-3">
          <span className="flex size-5 shrink-0 items-center justify-center border border-border text-xs text-foreground">
            {manageUrls.length + 2}
          </span>
          <div>
            <p>Return here. The list updates on its own, or refresh.</p>
            <Button
              variant="secondary"
              className="mt-2 h-8 rounded-none px-3"
              isPending={isRefreshing}
              isDisabled={isRefreshing}
              onPress={onRefresh}
            >
              Refresh
            </Button>
          </div>
        </li>
      </ol>
    </div>
  )
}
