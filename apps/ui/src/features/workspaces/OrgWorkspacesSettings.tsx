import { IconSettings } from "@tabler/icons-react"
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
              <div className="flex w-full items-center gap-2 rounded-lg px-3 py-2 hover:bg-zinc-900">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-baseline gap-3 text-left"
                  onClick={() => {
                    void navigate({
                      to: "/$orgSlug/ws/$workspaceSlug",
                      params: { orgSlug, workspaceSlug: workspace.slug },
                    })
                  }}
                >
                  <span className="truncate text-sm">
                    {workspace.displayName}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {workspace.slug}
                  </span>
                </button>
                <Button
                  variant="quiet"
                  size="icon-sm"
                  aria-label="Workspace settings"
                  onClick={(event) => event.stopPropagation()}
                  onPress={() => {
                    void navigate({
                      to: "/$orgSlug/ws/$workspaceSlug",
                      params: { orgSlug, workspaceSlug: workspace.slug },
                      search: { pane: "settings" },
                    })
                  }}
                >
                  <span className="size-4 text-muted-foreground" aria-hidden>
                    <IconSettings />
                  </span>
                </Button>
              </div>
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
