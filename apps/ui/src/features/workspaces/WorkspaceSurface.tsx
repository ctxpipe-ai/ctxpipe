import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { Component, type ReactNode, Suspense, useEffect, useState } from "react"
import { AppShell } from "@/components/AppShell"
import { cn } from "@/lib/utils"
import {
  closeFileTab,
  type FileTabSession,
  pinFile,
  previewFile,
  seedFileTabSession,
  tabsIncludingPanePath,
} from "./fileTabs"
import { type ParsedPane, parsePane, serializePane, visiblePane } from "./pane"
import {
  workspacePrepareNeedsPoll,
  workspaceProjectionReady,
} from "./projection"
import {
  touchWorkspace,
  workspaceConversationOptions,
  workspaceDetailOptions,
  workspaceKeys,
} from "./queries"
import type { WorkspaceDetail } from "./types"
import { WorkspaceChat } from "./WorkspaceChat"
import { WorkspaceHydrateProgress } from "./WorkspaceHydrateProgress"
import { WorkspacePane, WorkspacePaneTriggers } from "./WorkspacePane"
import { WorkspaceRouteError } from "./WorkspaceRouteError"

export function WorkspaceSurface(props: {
  orgSlug: string
  workspaceSlug: string
  conversationId?: string
  paneParam?: string
}) {
  return (
    <WorkspaceQueryErrorBoundary>
      <Suspense
        fallback={
          <AppShell>
            <p className="p-8 text-sm text-muted-foreground">
              Loading Workspace…
            </p>
          </AppShell>
        }
      >
        <WorkspaceSurfaceReady {...props} />
      </Suspense>
    </WorkspaceQueryErrorBoundary>
  )
}

class WorkspaceQueryErrorBoundary extends Component<
  { children: ReactNode },
  { error: unknown }
> {
  state: { error: unknown } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <WorkspaceRouteError
          error={this.state.error}
          reset={() => this.setState({ error: null })}
        />
      )
    }
    return this.props.children
  }
}

function WorkspaceSurfaceReady(props: {
  orgSlug: string
  workspaceSlug: string
  conversationId?: string
  paneParam?: string
}) {
  const { orgSlug, workspaceSlug, conversationId } = props
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { pane?: string }
  const paneParam =
    typeof search.pane === "string" ? search.pane : props.paneParam
  const queryClient = useQueryClient()
  const { data: workspace } = useSuspenseQuery({
    ...workspaceDetailOptions(orgSlug, workspaceSlug),
    refetchInterval: (query) => {
      const data = query.state.data
      if (!data) return false
      return workspacePrepareNeedsPoll(data) ? 2000 : false
    },
  })

  const pane = parsePane(paneParam)
  const shownPane = visiblePane(pane)
  const [maximized, setMaximized] = useState(false)
  const [paneWidth, setPaneWidth] = useState<number | null>(null)
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  const [paneCollapsed, setPaneCollapsed] = useState(false)
  const [fileTabs, setFileTabs] = useState<FileTabSession>({
    tabs: [],
    previewPath: null,
  })

  const fileFromPane = pane?.kind === "file" ? pane.path : null
  const openFileTabs = tabsIncludingPanePath(fileTabs.tabs, fileFromPane)

  useEffect(() => {
    void touchWorkspace(orgSlug, workspaceSlug).then(() => {
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.list(orgSlug),
      })
    })
  }, [orgSlug, workspaceSlug, queryClient])

  const setPane = (next: ParsedPane | null) => {
    if (next) setPaneCollapsed(false)
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

  if (workspace === null) {
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

  if (!workspaceProjectionReady(workspace)) {
    return (
      <AppShell>
        <WorkspaceHydrateProgress orgSlug={orgSlug} workspace={workspace} />
      </AppShell>
    )
  }

  if (conversationId) {
    return (
      <WorkspaceSurfaceShell
        orgSlug={orgSlug}
        workspace={workspace}
        conversationId={conversationId}
        shownPane={shownPane}
        maximized={maximized}
        paneWidth={paneWidth}
        treeCollapsed={treeCollapsed}
        paneCollapsed={paneCollapsed}
        fileTabs={openFileTabs}
        previewPath={fileTabs.previewPath}
        setMaximized={setMaximized}
        setPaneWidth={setPaneWidth}
        setTreeCollapsed={setTreeCollapsed}
        setPaneCollapsed={setPaneCollapsed}
        setFileTabs={setFileTabs}
        setPane={setPane}
      />
    )
  }

  return (
    <WorkspaceSurfaceLayout
      orgSlug={orgSlug}
      workspace={workspace}
      conversationTitle="New conversation"
      shownPane={shownPane}
      maximized={maximized}
      paneWidth={paneWidth}
      treeCollapsed={treeCollapsed}
      paneCollapsed={paneCollapsed}
      fileTabs={openFileTabs}
      previewPath={fileTabs.previewPath}
      setMaximized={setMaximized}
      setPaneWidth={setPaneWidth}
      setTreeCollapsed={setTreeCollapsed}
      setPaneCollapsed={setPaneCollapsed}
      setFileTabs={setFileTabs}
      setPane={setPane}
    />
  )
}

function WorkspaceSurfaceShell(props: {
  orgSlug: string
  workspace: WorkspaceDetail
  conversationId: string
  shownPane: ParsedPane | null
  maximized: boolean
  paneWidth: number | null
  treeCollapsed: boolean
  paneCollapsed: boolean
  fileTabs: string[]
  previewPath: string | null
  setMaximized: React.Dispatch<React.SetStateAction<boolean>>
  setPaneWidth: React.Dispatch<React.SetStateAction<number | null>>
  setTreeCollapsed: React.Dispatch<React.SetStateAction<boolean>>
  setPaneCollapsed: React.Dispatch<React.SetStateAction<boolean>>
  setFileTabs: React.Dispatch<React.SetStateAction<FileTabSession>>
  setPane: (next: ParsedPane | null) => void
}) {
  const { data } = useSuspenseQuery(
    workspaceConversationOptions(
      props.orgSlug,
      props.conversationId,
      props.workspace.id,
    ),
  )
  const conversationTitle = data?.conversation.name ?? "New conversation"

  return (
    <WorkspaceSurfaceLayout {...props} conversationTitle={conversationTitle} />
  )
}

function WorkspaceSurfaceLayout(props: {
  orgSlug: string
  workspace: WorkspaceDetail
  conversationId?: string
  conversationTitle: string
  shownPane: ParsedPane | null
  maximized: boolean
  paneWidth: number | null
  treeCollapsed: boolean
  paneCollapsed: boolean
  fileTabs: string[]
  previewPath: string | null
  setMaximized: React.Dispatch<React.SetStateAction<boolean>>
  setPaneWidth: React.Dispatch<React.SetStateAction<number | null>>
  setTreeCollapsed: React.Dispatch<React.SetStateAction<boolean>>
  setPaneCollapsed: React.Dispatch<React.SetStateAction<boolean>>
  setFileTabs: React.Dispatch<React.SetStateAction<FileTabSession>>
  setPane: (next: ParsedPane | null) => void
}) {
  return (
    <AppShell>
      <WorkspaceSurfaceColumns {...props} />
    </AppShell>
  )
}

function WorkspaceSurfaceColumns(props: {
  orgSlug: string
  workspace: WorkspaceDetail
  conversationId?: string
  conversationTitle: string
  shownPane: ParsedPane | null
  maximized: boolean
  paneWidth: number | null
  treeCollapsed: boolean
  paneCollapsed: boolean
  fileTabs: string[]
  previewPath: string | null
  setMaximized: React.Dispatch<React.SetStateAction<boolean>>
  setPaneWidth: React.Dispatch<React.SetStateAction<number | null>>
  setTreeCollapsed: React.Dispatch<React.SetStateAction<boolean>>
  setPaneCollapsed: React.Dispatch<React.SetStateAction<boolean>>
  setFileTabs: React.Dispatch<React.SetStateAction<FileTabSession>>
  setPane: (next: ParsedPane | null) => void
}) {
  const {
    orgSlug,
    workspace,
    conversationId,
    conversationTitle,
    shownPane,
    maximized,
    paneWidth,
    treeCollapsed,
    paneCollapsed,
    fileTabs,
    previewPath,
    setMaximized,
    setPaneWidth,
    setTreeCollapsed,
    setPaneCollapsed,
    setFileTabs,
    setPane,
  } = props

  const paneOpen = Boolean(shownPane) && !paneCollapsed
  const panePath = shownPane?.kind === "file" ? shownPane.path : null

  const collapsePane = () => {
    setMaximized(false)
    setFileTabs((current) => seedFileTabSession(current, panePath))
    setPaneCollapsed(true)
  }

  const openFile = (path: string, pin: boolean) => {
    setFileTabs((current) => {
      const seeded = seedFileTabSession(current, panePath)
      return pin ? pinFile(seeded, path) : previewFile(seeded, path)
    })
    setPane({ kind: "file", path })
  }

  return (
    <div className="flex h-svh min-h-0 min-w-0" data-workspace-surface="">
      {/*
        Column visibility is CSS:
        - maximised → hide chat
        - pane open below lg → hide chat (single column)
        - otherwise show chat
      */}
      <div
        className={cn(
          "flex h-full min-h-0 min-w-0 flex-1",
          maximized ? "hidden" : paneOpen ? "max-lg:hidden" : null,
        )}
      >
        <WorkspaceChat
          orgSlug={orgSlug}
          workspace={workspace}
          conversationId={conversationId}
          headerExtra={
            paneOpen ? null : (
              <WorkspacePaneTriggers
                onOpen={(next) => setPane(next)}
                onExpand={
                  fileTabs.length > 0
                    ? () => {
                        if (shownPane) setPaneCollapsed(false)
                        else setPane({ kind: "files" })
                      }
                    : undefined
                }
              />
            )
          }
        />
      </div>
      {paneOpen && shownPane ? (
        <WorkspacePane
          orgSlug={orgSlug}
          workspace={workspace}
          pane={shownPane}
          fileTabs={fileTabs}
          previewPath={previewPath}
          treeCollapsed={treeCollapsed}
          maximized={maximized}
          width={paneWidth}
          conversationTitle={conversationTitle}
          onPane={(next) => setPane(next)}
          onClose={collapsePane}
          onToggleMaximize={() => setMaximized((value) => !value)}
          onRestoreConversation={() => {
            setMaximized(false)
            // Below lg the tools pane owns the viewport — restore means hide it.
            if (
              typeof window !== "undefined" &&
              window.matchMedia("(max-width: 1023px)").matches
            ) {
              collapsePane()
            }
          }}
          onResize={setPaneWidth}
          onPreviewFile={(path) => openFile(path, false)}
          onPinFile={(path) => openFile(path, true)}
          onCloseFileTab={(path) => {
            setFileTabs((current) => closeFileTab(current, path))
            if (shownPane.kind === "file" && shownPane.path === path) {
              setPane({ kind: "files" })
            }
          }}
          onCloseActiveFile={() => {
            if (shownPane?.kind === "file") {
              const path = shownPane.path
              setFileTabs((current) => closeFileTab(current, path))
              setPane({ kind: "files" })
            }
          }}
          onToggleTree={() => setTreeCollapsed((value) => !value)}
        />
      ) : null}
    </div>
  )
}
