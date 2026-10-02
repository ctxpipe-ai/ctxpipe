import HyperDX from "@hyperdx/browser"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { DialogTrigger } from "react-aria-components"
import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { Popover } from "@/components/ui/Popover"
import {
  getRepositoryIndexingStatus,
  type Repository,
} from "@/features/repositories/types"
import { client } from "@/lib/api"
import { repositoryCount } from "./onboarding-state"

type OnboardingIndexingStatusProps = {
  orgSlug: string | null
  repositories: Repository[]
  /** Queued this visit, before the repository list shows it. */
  starting: boolean
}

/**
 * Header status for indexing. Failures name the repositories, say why, and
 * offer a retry here: the Repositories page is not reachable until
 * onboarding is finished.
 */
export function OnboardingIndexingStatus({
  orgSlug,
  repositories,
  starting,
}: OnboardingIndexingStatusProps) {
  const queryClient = useQueryClient()
  const retry = useMutation({
    mutationFn: async (ids: string[]) => {
      if (!orgSlug) return
      for (const id of ids) {
        const res = await client[":orgSlug"].api.v1.repositories[
          ":id"
        ].reindex.$post({ param: { id, orgSlug } })
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as {
            error?: string
          }
          throw new Error(err.error ?? "Could not retry indexing")
        }
      }
    },
    onSuccess: async () => {
      HyperDX.addAction("repository_index_started")
      await queryClient.invalidateQueries({
        queryKey: ["repositories", orgSlug],
      })
    },
  })

  const statuses = repositories.map((repo) => ({
    repo,
    status: getRepositoryIndexingStatus(repo),
  }))
  const active = statuses.filter(
    ({ status }) => status === "queued" || status === "running",
  )
  const running = statuses.filter(({ status }) => status === "running")
  const failed = statuses.filter(
    ({ status }) => status === "failed" || status === "complete_with_issues",
  )

  if (failed.length > 0) {
    return (
      <DialogTrigger>
        <Button
          variant="ghost"
          className="h-auto rounded-none border border-red-400/30 bg-zinc-950/90 px-3 py-2 font-mono text-xs text-red-200 hover:bg-red-400/10"
        >
          <span aria-hidden className="ctx-indexing-failed-dot" />
          {repositoryCount(failed.length)} did not finish indexing · Review
        </Button>
        <Popover placement="bottom end" className="w-96 max-w-[90vw]">
          <Dialog aria-label="Repositories that did not finish indexing">
            <div className="flex flex-col gap-3">
              <p className="m-0 text-sm text-zinc-300">
                These stopped before indexing finished. Retrying queues them
                again; the rest keep indexing.
              </p>
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {failed.map(({ repo, status }) => (
                  <li key={repo.id} className="flex flex-col gap-1">
                    <span className="flex items-center justify-between gap-3">
                      <span className="truncate font-mono text-xs text-zinc-100">
                        {repo.name}
                      </span>
                      <span className="shrink-0 text-xs text-red-200">
                        {status === "failed" ? "Failed" : "Indexed with issues"}
                      </span>
                    </span>
                    {repo.indexingError ? (
                      <span
                        className="line-clamp-2 text-xs text-zinc-400"
                        title={repo.indexingError}
                      >
                        {repo.indexingError.split("\n")[0]}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
              {retry.error ? (
                <p role="alert" className="m-0 text-xs text-red-300">
                  {retry.error.message}
                </p>
              ) : null}
              <div className="flex justify-end">
                <Button
                  variant="primary"
                  className="rounded-none"
                  isPending={retry.isPending}
                  onPress={() =>
                    retry.mutate(failed.map(({ repo }) => repo.id))
                  }
                >
                  {failed.length === 1 ? "Retry" : `Retry ${failed.length}`}
                </Button>
              </div>
            </div>
          </Dialog>
        </Popover>
      </DialogTrigger>
    )
  }

  const label =
    active.length > 0
      ? `${running.length > 0 ? "Indexing" : "Preparing"} ${repositoryCount(active.length)}`
      : starting && repositories.length === 0
        ? "Starting repository indexing"
        : null
  if (!label) return null
  return (
    <output
      aria-live="polite"
      className="inline-flex items-center gap-2 border border-teal-400/30 bg-zinc-950/90 px-3 py-2 font-mono text-xs text-teal-100"
    >
      <span aria-hidden className="ctx-indexing-dot" />
      {label}
    </output>
  )
}
