import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { Dialog } from "react-aria-components"
import { Button } from "@/components/ui/Button"
import { Modal } from "@/components/ui/Modal"
import { fetchWorkspaces, workspaceKeys } from "./queries"
import { WorkspaceCreateForm } from "./WorkspaceCreateForm"

export function OrgWorkspacesSettings(props: { orgSlug: string }) {
  const { orgSlug } = props
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const query = useQuery({
    queryKey: workspaceKeys.list(orgSlug),
    queryFn: () => fetchWorkspaces(orgSlug),
  })
  const items = query.data?.items ?? []

  return (
    <section className="mb-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium tracking-tight">Workspaces</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Context Workspaces in this organisation. Add Workspace uses the same
            create, select, or paste flows.
          </p>
        </div>
        <Button variant="primary" onPress={() => setOpen(true)}>
          Add Workspace
        </Button>
      </div>
      <ul className="mt-4 space-y-1">
        {query.isPending ? (
          <li className="text-sm text-muted-foreground">Loading…</li>
        ) : items.length === 0 ? (
          <li className="text-sm text-muted-foreground">No Workspaces yet.</li>
        ) : (
          items.map((workspace) => (
            <li key={workspace.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-zinc-900"
                onClick={() => {
                  void navigate({
                    to: "/$orgSlug/ws/$workspaceSlug",
                    params: { orgSlug, workspaceSlug: workspace.slug },
                    search: { pane: "settings" },
                  })
                }}
              >
                <span className="text-sm">{workspace.displayName}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {workspace.slug}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
      <Modal isOpen={open} onOpenChange={setOpen} isDismissable>
        <Dialog className="max-h-[inherit] overflow-auto p-6">
          <WorkspaceCreateForm
            orgSlug={orgSlug}
            onCreated={(slug) => {
              setOpen(false)
              void navigate({
                to: "/$orgSlug/ws/$workspaceSlug",
                params: { orgSlug, workspaceSlug: slug },
              })
            }}
          />
        </Dialog>
      </Modal>
    </section>
  )
}
