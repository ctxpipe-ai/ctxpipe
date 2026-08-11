"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { Checkbox } from "@/components/ui/Checkbox"
import { CheckboxGroup } from "@/components/ui/CheckboxGroup"
import { InlineLoader } from "@/components/ui/InlineLoader"
import {
  fetchLinearAvailableScopes,
  fetchLinearConnectorConfig,
  type LinearScope,
  linearConnectorKeys,
  patchLinearConnectorConfig,
} from "../../queries/linear-connector"

const scopeTypeLabels: Record<LinearScope["type"], string> = {
  team: "Teams",
  project: "Projects",
  document: "Documents",
  initiative: "Initiatives",
}

type LinearScopeStepProps = {
  orgSlug: string
  connectionId: string
  onSaved: () => Promise<unknown>
  onScopesSubmitted: (scopes: LinearScope[]) => void
  onSubmissionFailed: () => void
  onBack?: () => void
}

export function LinearScopeStep({
  orgSlug,
  connectionId,
  onSaved,
  onScopesSubmitted,
  onSubmissionFailed,
  onBack,
}: LinearScopeStepProps) {
  const queryClient = useQueryClient()
  const [selectionOverride, setSelectionOverride] = useState<string[] | null>(
    null,
  )
  const scopesQuery = useQuery({
    queryKey: linearConnectorKeys.availableScopes(orgSlug, connectionId),
    queryFn: () => fetchLinearAvailableScopes(orgSlug, connectionId),
  })
  const configQuery = useQuery({
    queryKey: linearConnectorKeys.config(orgSlug, connectionId),
    queryFn: () => fetchLinearConnectorConfig(orgSlug, connectionId),
  })
  const selectedIds =
    selectionOverride ??
    configQuery.data?.scopes.map(
      (scope) => `${scope.type}:${scope.externalId}`,
    ) ??
    []
  const selected = new Set(selectedIds)
  const selectedScopes =
    scopesQuery.data?.filter((scope) =>
      selected.has(`${scope.type}:${scope.externalId}`),
    ) ?? []
  const configuredIds = new Set(
    configQuery.data?.scopes.map(
      (scope) => `${scope.type}:${scope.externalId}`,
    ) ?? [],
  )
  const scopeChanged =
    configuredIds.size !== selected.size ||
    selectedIds.some((id) => !configuredIds.has(id))

  const saveMutation = useMutation({
    mutationFn: () => {
      if (selectedScopes.length === 0) {
        throw new Error("Select at least one item")
      }
      return patchLinearConnectorConfig(orgSlug, connectionId, {
        scopes: selectedScopes,
      })
    },
    onMutate: () => {
      onScopesSubmitted(selectedScopes)
    },
    onSuccess: async () => {
      toast.success(
        "Linear scope saved. The configuration pull request is being prepared.",
      )
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: linearConnectorKeys.config(orgSlug, connectionId),
        }),
        onSaved(),
      ])
    },
    onError: (error: Error) => {
      onSubmissionFailed()
      toast.error(error.message)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: linearConnectorKeys.status(orgSlug, connectionId),
      })
    },
  })

  if (scopesQuery.isPending || configQuery.isPending) {
    return <InlineLoader label="Discovering Linear content" />
  }
  if (scopesQuery.isError || configQuery.isError) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-destructive">
          Could not load Linear content. Check the connection and try again.
        </p>
        <Button
          variant="secondary"
          className="rounded-none"
          onPress={() => {
            void Promise.all([scopesQuery.refetch(), configQuery.refetch()])
          }}
        >
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Configure Linear scope
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Select teams or individual projects, documents and initiatives. Team
          selection includes descendant issues, comments, cycles and labels.
        </p>
      </div>
      <CheckboxGroup
        value={selectedIds}
        onChange={setSelectionOverride}
        aria-label="Linear content scope"
        className="max-h-[min(48vh,28rem)] gap-0 overflow-y-auto border border-border"
      >
        {(["team", "project", "document", "initiative"] as const).map(
          (type) => {
            const items = scopesQuery.data?.filter(
              (scope) => scope.type === type,
            )
            if (!items || items.length === 0) return null
            return (
              <section
                key={type}
                className="border-t border-border first:border-t-0"
              >
                <h4 className="border-b border-border bg-card/40 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {scopeTypeLabels[type]}
                </h4>
                <div>
                  {items.map((scope) => {
                    const value = `${scope.type}:${scope.externalId}`
                    return (
                      <Checkbox
                        key={value}
                        value={value}
                        className="w-full cursor-pointer items-start border-b border-border px-3 py-2 last:border-b-0 hover:bg-foreground/[0.03]"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-foreground">
                            {scope.title}
                          </span>
                          {scope.teamKey ? (
                            <span className="block text-xs text-muted-foreground">
                              Team {scope.teamKey}
                            </span>
                          ) : null}
                        </span>
                      </Checkbox>
                    )
                  })}
                </div>
              </section>
            )
          },
        )}
      </CheckboxGroup>
      {selectedIds.length > 0 ? (
        <div className="text-sm text-muted-foreground">
          {selectedIds.length} selected
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Customer requests can contain external names, feedback, or support
        context. Review repository access before enabling them. Attachment
        binaries and GitHub pull request bodies are excluded.
      </p>
      <div className="flex items-center justify-between border-t border-border pt-4">
        {onBack ? (
          <Button variant="secondary" className="rounded-none" onPress={onBack}>
            Back
          </Button>
        ) : (
          <span />
        )}
        <Button
          variant="primary"
          className="rounded-none"
          isPending={saveMutation.isPending}
          isDisabled={
            saveMutation.isPending || selectedIds.length === 0 || !scopeChanged
          }
          onPress={() => saveMutation.mutate()}
        >
          Save scope and create pull request
        </Button>
      </div>
    </div>
  )
}
