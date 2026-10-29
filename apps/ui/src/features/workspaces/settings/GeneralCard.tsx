import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/Button"
import { TextField } from "@/components/ui/TextField"

import { updateWorkspace, workspaceKeys } from "../queries"
import type { WorkspaceDetail } from "../types"
import { SettingsCard } from "./SettingsCard"

/** The name and the URL name of the Workspace, with one Save. */
export function GeneralCard(props: {
  orgSlug: string
  workspace: WorkspaceDetail
}) {
  const { orgSlug, workspace } = props
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [displayName, setDisplayName] = useState(workspace.displayName)
  const [slug, setSlug] = useState(workspace.slug)
  const dirty =
    displayName.trim() !== workspace.displayName ||
    slug.trim() !== workspace.slug

  const saveMutation = useMutation({
    mutationFn: () =>
      updateWorkspace(orgSlug, workspace.slug, { displayName, slug }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.list(orgSlug),
      })
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.detail(orgSlug, workspace.slug),
      })
      toast.success("Workspace updated")
      if (updated.slug !== workspace.slug) {
        void navigate({
          to: "/$orgSlug/ws/$workspaceSlug",
          params: { orgSlug, workspaceSlug: updated.slug },
          search: { pane: "settings" },
        })
      }
    },
    onError: (error: Error) => {
      toast.error(error.message)
    },
  })

  return (
    <SettingsCard
      part="general"
      status={dirty ? "Not saved" : null}
      footer={
        <>
          {dirty ? (
            <Button
              variant="ghost"
              isDisabled={saveMutation.isPending}
              onPress={() => {
                setDisplayName(workspace.displayName)
                setSlug(workspace.slug)
              }}
            >
              Reset
            </Button>
          ) : null}
          <Button
            type="submit"
            form="workspace-settings"
            variant="primary"
            isPending={saveMutation.isPending}
            isDisabled={!dirty}
          >
            Save
          </Button>
        </>
      }
    >
      <form
        id="workspace-settings"
        className="grid items-start gap-4 @2xl:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (dirty) saveMutation.mutate()
        }}
      >
        <TextField
          label="Name"
          value={displayName}
          onChange={setDisplayName}
          description="Shown in the sidebar and to your team."
        />
        <TextField
          label="URL name"
          value={slug}
          onChange={setSlug}
          description="Used in this Workspace's web address. If you change it, old links stop working."
        />
      </form>
    </SettingsCard>
  )
}
