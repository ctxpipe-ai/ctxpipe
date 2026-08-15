import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { AppShell } from "@/components/AppShell"
import { type ParsedPane, parsePane, serializePane, visiblePane } from "./pane"
import {
  fetchConversation,
  fetchWorkspace,
  touchWorkspace,
  workspaceKeys,
} from "./queries"
import { WorkspaceChat } from "./WorkspaceChat"
import { WorkspacePane, WorkspacePaneTriggers } from "./WorkspacePane"

export function WorkspaceSurface(props: {
  orgSlug: string
  workspaceSlug: string
  conversationId?: string
  paneParam?: string
}) {
  const { orgSlug, workspaceSlug, conversationId, paneParam } = props
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const workspaceQuery = useQuery({
    queryKey: workspaceKeys.detail(orgSlug, workspaceSlug),
    queryFn: () => fetchWorkspace(orgSlug, workspaceSlug),
  })
  const conversationQuery = useQuery({
    queryKey: ["conversation", orgSlug, conversationId],
    enabled: Boolean(conversationId),
    queryFn: () => {
      if (!conversationId) throw new Error("Missing conversation id")
      return fetchConversation(orgSlug, conversationId)
    },
  })
  const pane = parsePane(paneParam)
  const shownPane = visiblePane(pane)
  const [maximized, setMaximized] = useState(false)
  const [paneWidth, setPaneWidth] = useState(380)
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [sessionFileTabs, setSessionFileTabs] = useState<string[]>([])

  const fileFromPane = pane?.kind === "file" ? pane.path : null
  const fileTabs =
    fileFromPane && !sessionFileTabs.includes(fileFromPane)
      ? [...sessionFileTabs, fileFromPane]
      : sessionFileTabs

  useEffect(() => {
    void touchWorkspace(orgSlug, workspaceSlug).then(() => {
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.list(orgSlug),
      })
    })
  }, [orgSlug, workspaceSlug, queryClient])

  const setPane = (next: ParsedPane | null) => {
    void navigate({
      to: conversationId
        ? "/$orgSlug/ws/$workspaceSlug/$conversationId"
        : "/$orgSlug/ws/$workspaceSlug",
      params: conversationId
        ? { orgSlug, workspaceSlug, conversationId }
        : { orgSlug, workspaceSlug },
      search: next ? { pane: serializePane(next) } : {},
      replace: true,
    })
  }

  if (workspaceQuery.isPending) {
    return (
      <AppShell>
        <p className="p-8 text-sm text-muted-foreground">Loading Workspace…</p>
      </AppShell>
    )
  }
  if (workspaceQuery.data === null) {
    return (
      <AppShell>
        <main className="mx-auto max-w-lg px-6 py-16">
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-teal-400">
            Workspace
          </p>
          <h1 className="mt-3 text-xl font-medium tracking-tight">
            Workspace not found
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            That slug is not used in this organisation. Changing a slug replaces
            the URL; the old slug is not kept as an alias.
          </p>
        </main>
      </AppShell>
    )
  }
  const workspace = workspaceQuery.data
  if (!workspace) {
    return (
      <AppShell>
        <p className="p-8 text-sm text-muted-foreground">
          Could not load this Workspace.
        </p>
      </AppShell>
    )
  }

  const conversationTitle = conversationId
    ? (conversationQuery.data?.conversation.name ?? "New conversation")
    : "New conversation"

  return (
    <AppShell>
      <div className="flex min-h-screen min-w-0">
        {maximized ? null : (
          <WorkspaceChat
            orgSlug={orgSlug}
            workspace={workspace}
            conversationId={conversationId}
            headerExtra={
              shownPane ? null : (
                <WorkspacePaneTriggers onOpen={(next) => setPane(next)} />
              )
            }
          />
        )}
        {shownPane ? (
          <WorkspacePane
            orgSlug={orgSlug}
            workspace={workspace}
            pane={shownPane}
            fileTabs={fileTabs}
            selectedFilePath={selectedFilePath}
            treeCollapsed={treeCollapsed}
            maximized={maximized}
            width={paneWidth}
            conversationTitle={conversationTitle}
            onPane={(next) => setPane(next)}
            onClose={() => {
              setMaximized(false)
              setPane(null)
            }}
            onToggleMaximize={() => setMaximized((value) => !value)}
            onRestoreConversation={() => setMaximized(false)}
            onResize={setPaneWidth}
            onSelectFile={(path) => {
              setSelectedFilePath(path)
              setPane({ kind: "files" })
            }}
            onOpenFileTab={(path) => {
              setSessionFileTabs((tabs) =>
                tabs.includes(path) ? tabs : [...tabs, path],
              )
              setSelectedFilePath(path)
              setPane({ kind: "file", path })
            }}
            onCloseFileTab={(path) => {
              setSessionFileTabs((tabs) => tabs.filter((item) => item !== path))
              if (shownPane.kind === "file" && shownPane.path === path) {
                setPane({ kind: "files" })
              }
            }}
            onToggleTree={() => setTreeCollapsed((value) => !value)}
          />
        ) : null}
      </div>
    </AppShell>
  )
}
