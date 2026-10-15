import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Heading } from "react-aria-components"
import { toast } from "sonner"
import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { Modal } from "@/components/ui/Modal"
import { TextField } from "@/components/ui/TextField"
import {
  renameWorkspaceSource,
  type SourceDelivery,
  sourceChangeMessage,
  workspaceSourceKeys,
} from "./queries"

const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,99}$/

/**
 * Rename one source file. The folder stays, so the provider cannot change.
 * Each unit that names the old path gets the new path in the same change.
 */
export function RenameSourceDialog(props: {
  orgSlug: string
  workspaceSlug: string
  path: string
  directCommitAllowed: boolean
  onClose: () => void
}) {
  const { orgSlug, workspaceSlug, path, directCommitAllowed, onClose } = props
  const queryClient = useQueryClient()
  const folder = path.slice(0, path.lastIndexOf("/"))
  const [name, setName] = useState(
    path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, ""),
  )
  const newPath = `${folder}/${name}.md`
  const valid = SEGMENT.test(name) && newPath !== path

  const mutation = useMutation({
    mutationFn: (delivery: SourceDelivery) =>
      renameWorkspaceSource(orgSlug, workspaceSlug, path, newPath, delivery),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: workspaceSourceKeys.list(orgSlug, workspaceSlug),
      })
      toast.success(sourceChangeMessage(result))
      onClose()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      isDismissable={!mutation.isPending}
      size="medium"
      placement="top"
    >
      <Dialog>
        <Heading
          slot="title"
          className="my-0 text-lg font-medium leading-6 text-foreground"
        >
          Rename {path}
        </Heading>
        <p className="mt-1 text-sm text-muted-foreground">
          The change moves the file. Each file that lists this path in its
          sources gets the new path in the same change.
        </p>
        <div className="mt-5">
          <TextField
            label="File name"
            value={name}
            onChange={setName}
            description={`Saved as ${newPath}`}
            isInvalid={!SEGMENT.test(name)}
            errorMessage="Use lowercase letters, digits, '.', '_', and '-'."
            autoFocus
          />
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="quiet" onPress={onClose}>
            Cancel
          </Button>
          {directCommitAllowed ? (
            <Button
              variant="secondary"
              isDisabled={!valid || mutation.isPending}
              onPress={() => mutation.mutate("commit")}
            >
              Commit directly
            </Button>
          ) : null}
          <Button
            variant="primary"
            isDisabled={!valid}
            isPending={mutation.isPending}
            onPress={() => mutation.mutate("pull_request")}
          >
            Open a pull request
          </Button>
        </div>
      </Dialog>
    </Modal>
  )
}
