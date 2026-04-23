"use client"

import { IconBrandGithub } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Button } from "@/components/ui/Button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card"
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
    <span className="text-zinc-400">Loading…</span>
  ) : installation ? (
    installation.accountSlug ? (
      installation.accountSlug
    ) : (
      <span className="text-zinc-400">
        Installation #{installation.installationId}
      </span>
    )
  ) : (
    <span className="text-zinc-400">Not linked</span>
  )

  const repositoriesDisplay = isPending ? (
    <span className="text-zinc-400">Loading…</span>
  ) : installation ? (
    <span className="tabular-nums">
      {typeof installation.ingestionRepositoryCount === "number" &&
      Number.isFinite(installation.ingestionRepositoryCount)
        ? String(Math.trunc(installation.ingestionRepositoryCount))
        : "0"}
    </span>
  ) : (
    <span className="text-zinc-400">—</span>
  )

  return (
    <Card className="h-full min-h-0 rounded-none">
      <CardHeader className="shrink-0 flex flex-row items-start gap-3 space-y-0 rounded-none">
        <div className="flex min-w-0 gap-4">
          <IconBrandGithub className="size-10 shrink-0 text-zinc-100" />
          <div className="min-w-0 space-y-1 -mt-1">
            <CardTitle>GitHub</CardTitle>
            <CardDescription>
              GitHub App installation for repository access and ingestion.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 space-y-4 py-0">
        <dl className="flex flex-col gap-4">
          <div className="min-w-0">
            <dt className="text-sm font-medium text-zinc-500">Account</dt>
            <dd className="mt-1 text-sm text-zinc-100">{accountDisplay}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-sm font-medium text-zinc-500">Repositories</dt>
            <dd className="mt-1 text-sm text-zinc-100">{repositoriesDisplay}</dd>
          </div>
        </dl>
      </CardContent>
      <CardFooter className="mt-auto shrink-0 flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          onPress={() => {
            void navigate({ to: "/$orgSlug/repositories", params: { orgSlug } })
          }}
        >
          Manage repositories
        </Button>
      </CardFooter>
    </Card>
  )
}
