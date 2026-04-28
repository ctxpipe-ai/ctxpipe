"use client"

import { IconBrandGithub } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Button } from "@/components/ui/Button"

type GithubConnectionCardProps = {
  orgSlug: string
  connectionId: string
}

export function GithubConnectionCard({
  orgSlug,
  connectionId,
}: GithubConnectionCardProps) {
  const navigate = useNavigate()
  const { data: installation, isPending } = useQuery({
    queryKey: ["github-installation", orgSlug, connectionId],
    queryFn: async () => {
      const qs = new URLSearchParams({ connectionId })
      const res = await fetch(
        `/${orgSlug}/api/v1/github/installation?${qs.toString()}`,
        { credentials: "include" },
      )
      if (!res.ok) throw new Error("Failed to load GitHub connection")
      return (await res.json()) as {
        id: string
        installationId: number
        accountSlug: string | null
        ingestionRepositoryCount: number
      } | null
    },
  })

  const accountDisplay = isPending ? (
    <span className="text-muted-foreground">Loading…</span>
  ) : installation ? (
    installation.accountSlug ? (
      installation.accountSlug
    ) : (
      <span className="text-muted-foreground">
        Installation #{installation.installationId}
      </span>
    )
  ) : (
    <span className="text-muted-foreground">Not linked</span>
  )

  const repositoriesDisplay = isPending ? (
    <span className="text-muted-foreground">Loading…</span>
  ) : installation ? (
    <span className="tabular-nums">
      {typeof installation.ingestionRepositoryCount === "number" &&
      Number.isFinite(installation.ingestionRepositoryCount)
        ? String(Math.trunc(installation.ingestionRepositoryCount))
        : "0"}
    </span>
  ) : (
    <span className="text-muted-foreground">—</span>
  )

  return (
    <article className="flex min-h-0 flex-col border border-border bg-transparent px-5 py-4 text-sm">
      <header className="flex shrink-0 items-start gap-3">
        <div className="flex min-w-0 gap-3">
          <span className="ctx-node h-9 w-9">
            <IconBrandGithub className="h-4 w-4 text-foreground" />
          </span>
          <div className="min-w-0 space-y-1">
            <h2 className="font-medium text-foreground">GitHub</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              GitHub App installation for repository access and ingestion.
            </p>
          </div>
        </div>
      </header>
      <div className="mt-5 flex min-h-0 flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <dl className="grid min-w-0 flex-1 grid-cols-2 gap-4">
          <div className="min-w-0">
            <dt className="text-sm font-medium text-muted-foreground">
              Account
            </dt>
            <dd className="mt-1 text-sm text-foreground">{accountDisplay}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-sm font-medium text-muted-foreground">
              Repositories
            </dt>
            <dd className="mt-1 text-sm text-foreground">
              {repositoriesDisplay}
            </dd>
          </div>
        </dl>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            className="rounded-none"
            onPress={() => {
              void navigate({
                to: "/$orgSlug/repositories",
                params: { orgSlug },
              })
            }}
          >
            Manage repositories
          </Button>
        </div>
      </div>
    </article>
  )
}
