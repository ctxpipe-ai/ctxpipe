import { IconAlertCircle } from "@tabler/icons-react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { Heading } from "react-aria-components"
import { toast } from "sonner"

import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { Modal } from "@/components/ui/Modal"
import { TextField } from "@/components/ui/TextField"

import {
  deleteWorkspace,
  forgetDeletedWorkspace,
  workspaceKeys,
} from "../queries"
import type { WorkspaceDetail } from "../types"
import { workspaceDeleteNameMatches } from "../workspaceDeleteNameMatches"
import { SettingsCard } from "./SettingsCard"

/** Delete the Workspace: the user types its name to confirm. */
export function DangerCard(props: {
  orgSlug: string
  workspace: WorkspaceDetail
}) {
  const { orgSlug, workspace } = props
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [confirmName, setConfirmName] = useState("")
  const nameMatches = workspaceDeleteNameMatches(
    confirmName,
    workspace.displayName,
  )

  // Remove the caches of a deleted Workspace only after this card unmounts.
  // While the Workspace is on screen, a removed query would read again, get a
  // 404, and replace the page with an error.
  const deletedRef = useRef(false)
  useEffect(
    () => () => {
      if (!deletedRef.current) return
      setTimeout(() => {
        queryClient.removeQueries({
          predicate: ({ queryKey: [, org, slug] }) =>
            org === orgSlug && slug === workspace.slug,
        })
      })
    },
    [queryClient, orgSlug, workspace.slug],
  )

  const deleteMutation = useMutation({
    mutationFn: (name: string) =>
      deleteWorkspace(orgSlug, workspace.slug, name),
    onSuccess: async () => {
      toast.success("Workspace deleted")
      deletedRef.current = true
      setDeleteOpen(false)
      await forgetDeletedWorkspace(queryClient, orgSlug, workspace.id)
      void navigate({
        to: "/$orgSlug",
        params: { orgSlug },
        replace: true,
      }).then(() => {
        void queryClient.invalidateQueries({
          queryKey: workspaceKeys.list(orgSlug),
        })
      })
    },
    onError: (error: Error) => {
      toast.error(error.message)
    },
  })

  return (
    <SettingsCard part="danger" title="Danger zone" danger>
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="text-sm text-foreground">Delete this Workspace</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Deletes this Workspace and its conversations. Your GitHub repository
            and its files stay.
          </p>
        </div>
        <Button
          variant="outline"
          className="shrink-0"
          onPress={() => {
            setConfirmName("")
            setDeleteOpen(true)
          }}
        >
          Delete Workspace
        </Button>
      </section>

      <Modal
        isOpen={deleteOpen}
        onOpenChange={(open) => {
          setDeleteOpen(open)
          if (!open) setConfirmName("")
        }}
        isDismissable={!deleteMutation.isPending}
      >
        <Dialog role="alertdialog">
          {({ close }) => (
            <>
              <Heading
                slot="title"
                className="my-0 text-lg font-medium leading-6 text-foreground"
              >
                Delete Workspace?
              </Heading>
              <div className="absolute right-6 top-6 size-6 text-destructive">
                <IconAlertCircle aria-hidden className="size-6 stroke-2" />
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                Type{" "}
                <strong className="font-medium text-foreground">
                  {workspace.displayName}
                </strong>{" "}
                to confirm. This deletes the Workspace and its conversations.
                Your GitHub repository stays.
              </p>
              <form
                className="mt-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (deleteMutation.isPending || !nameMatches) return
                  deleteMutation.mutate(confirmName.trim())
                }}
              >
                <TextField
                  label="Workspace name"
                  placeholder={workspace.displayName}
                  value={confirmName}
                  onChange={setConfirmName}
                  autoFocus
                />
                <div className="mt-6 flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="quiet"
                    isDisabled={deleteMutation.isPending}
                    onPress={close}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="destructive"
                    isPending={deleteMutation.isPending}
                    isDisabled={!nameMatches}
                  >
                    Delete Workspace
                  </Button>
                </div>
              </form>
            </>
          )}
        </Dialog>
      </Modal>
    </SettingsCard>
  )
}
