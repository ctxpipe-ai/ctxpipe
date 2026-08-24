import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import { Dialog } from "react-aria-components"
import { Modal } from "@/components/ui/Modal"
import { SearchField } from "@/components/ui/SearchField"
import { fetchWorkspaces, workspaceKeys } from "./queries"

export function WorkspaceCommandPalette(props: {
  orgSlug: string
  isOpen: boolean
  onOpenChange: (open?: boolean) => void
}) {
  const { orgSlug, isOpen, onOpenChange } = props
  const navigate = useNavigate()
  const [query, setQuery] = useState("")
  const workspacesQuery = useQuery({
    queryKey: workspaceKeys.list(orgSlug),
    queryFn: () => fetchWorkspaces(orgSlug),
    enabled: isOpen,
  })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        onOpenChange(!isOpen)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [isOpen, onOpenChange])

  const items = useMemo(() => {
    const workspaces = (workspacesQuery.data?.items ?? []).map((workspace) => ({
      id: `ws:${workspace.slug}`,
      label: workspace.displayName,
      hint: workspace.slug,
    }))
    const all = [
      { id: "home", label: "Home", hint: "page" },
      { id: "connectors", label: "Connectors", hint: "page" },
      ...workspaces,
    ]
    const needle = query.trim().toLowerCase()
    if (!needle) return all
    return all.filter(
      (item) =>
        item.label.toLowerCase().includes(needle) ||
        item.hint.toLowerCase().includes(needle),
    )
  }, [query, workspacesQuery.data?.items])

  const go = (id: string) => {
    if (id === "home") {
      void navigate({ to: "/$orgSlug", params: { orgSlug } })
    } else if (id === "connectors") {
      void navigate({
        to: "/$orgSlug/connectors",
        params: { orgSlug },
        search: {
          error: undefined,
          error_description: undefined,
          pendingAccountClaim: undefined,
          notionConnectionId: undefined,
        },
      })
    } else if (id.startsWith("ws:")) {
      void navigate({
        to: "/$orgSlug/ws/$workspaceSlug",
        params: { orgSlug, workspaceSlug: id.slice(3) },
      })
    }
    onOpenChange(false)
    setQuery("")
  }

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange} isDismissable>
      <Dialog className="flex max-h-[inherit] flex-col p-3">
        <SearchField
          autoFocus
          aria-label="Search"
          placeholder="Jump to…"
          value={query}
          onChange={setQuery}
        />
        <ul className="mt-2 max-h-80 overflow-auto">
          {items.length === 0 ? (
            <li className="px-2 py-2 text-sm text-muted-foreground">
              No results found.
            </li>
          ) : (
            items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-sm hover:bg-zinc-900"
                  onClick={() => go(item.id)}
                >
                  <span>{item.label}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {item.hint}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </Dialog>
    </Modal>
  )
}
