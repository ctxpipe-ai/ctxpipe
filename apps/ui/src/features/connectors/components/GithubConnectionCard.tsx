"use client"

import { IconBrandGithub } from "@tabler/icons-react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
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
      } | null
    },
  })

  const statusLabel = isPending
    ? "Loading…"
    : installation
      ? `Installation #${installation.installationId}`
      : "Not linked"

  return (
    <Card className="rounded-none py-5">
      <CardHeader className="flex flex-row items-start gap-3 space-y-0 rounded-none">
        <IconBrandGithub className="size-10 shrink-0 text-zinc-100" />
        <div className="min-w-0 space-y-1">
          <CardTitle>GitHub</CardTitle>
          <CardDescription>
            GitHub App installation for repository access and ingestion.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <span className="inline-flex rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300">
          {statusLabel}
        </span>
      </CardContent>
      <CardFooter className="justify-end rounded-none">
        <Link
          to="/$orgSlug/repositories"
          params={{ orgSlug }}
          className="text-sm font-medium text-teal-400 hover:text-teal-300"
        >
          Manage repositories →
        </Link>
      </CardFooter>
    </Card>
  )
}
