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
}

export function LinearScopeStep({
  orgSlug,
  connectionId,
  onSaved,
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

  const saveMutation = useMutation({
    mutationFn: () => {
      const selected = new Set(selectedIds)
      const scopes =
        scopesQuery.data?.filter((scope) =>
          selected.has(`${scope.type}:${scope.externalId}`),
        ) ?? []
      if (scopes.length === 0) throw new Error("Select at least one item")
      return patchLinearConnectorConfig(orgSlug, connectionId, { scopes })
    },
    onSuccess: async () => {
      toast.success(
        "Linear scope saved. The configuration pull request is being prepared.",
      )
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: linearConnectorKeys.status(orgSlug, connectionId),
        }),
        queryClient.invalidateQueries({
          queryKey: linearConnectorKeys.config(orgSlug, connectionId),
        }),
        onSaved(),
      ])
    },
    onError: (error: Error) => toast.error(error.message),
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
        className="max-h-[min(48vh,28rem)] gap-5 overflow-y-auto pr-2"
      >
        {(["team", "project", "document", "initiative"] as const).map(
          (type) => {
            const items = scopesQuery.data?.filter(
              (scope) => scope.type === type,
            )
            if (!items || items.length === 0) return null
            return (
              <section key={type} className="space-y-2">
                <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {scopeTypeLabels[type]}
                </h4>
                <div className="space-y-2">
                  {items.map((scope) => {
                    const value = `${scope.type}:${scope.externalId}`
                    return (
                      <Checkbox key={value} value={value}>
                        <span className="min-w-0">
                          <span className="block truncate">{scope.title}</span>
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
      <p className="text-xs text-muted-foreground">
        Customer requests are mirrored without customer identity fields.
        Attachment binaries and GitHub pull request bodies are excluded.
      </p>
      <Button
        variant="primary"
        className="rounded-none"
        isPending={saveMutation.isPending}
        isDisabled={selectedIds.length === 0}
        onPress={() => saveMutation.mutate()}
      >
        Save scope and create pull request
      </Button>
    </div>
  )
}
