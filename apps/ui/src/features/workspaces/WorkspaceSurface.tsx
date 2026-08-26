import {
  type QueryClient,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router"
import {
  Component,
  type ReactNode,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react"
import { parseSideNavLocation } from "@/components/SideNav/sideNavLocation"
import { pollWhileOk } from "@/lib/api-result"
import { cn } from "@/lib/utils"
import {
  closeFileTab,
  type FileTabSession,
  pinFile,
  previewFile,
  seedFileTabSession,
  tabsIncludingPanePath,
} from "./fileTabs"
import {
  landingPane,
  type ParsedPane,
  serializePane,
  visiblePane,
} from "./pane"
import {
  workspaceHydrateView,
  workspacePrepareNeedsPoll,
  workspaceProjectionReady,
} from "./projection"
import {
  touchWorkspace,
  workspaceDetailOptions,
  workspaceKeys,
} from "./queries"
import type { WorkspaceDetail } from "./types"
import { WorkspaceChat } from "./WorkspaceChat"
import { WorkspaceChatChrome } from "./WorkspaceChatChrome"
import {
  WorkspaceHydrateFailedBody,
  WorkspaceHydrateProgress,
} from "./WorkspaceHydrateProgress"
import { WorkspacePane, WorkspacePaneTriggers } from "./WorkspacePane"
import { WorkspaceRouteError } from "./WorkspaceRouteError"
import { WorkspaceSurfaceSkeleton } from "./workspaceSkeletons"

export function WorkspaceSurface(props: {
  orgSlug: string
  workspaceSlug: string
  conversationId?: string
  paneParam?: string
}) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const conversationId =
    parseSideNavLocation(pathname, props.orgSlug).conversationId ??
    props.conversationId
  return (
    <WorkspaceQueryErrorBoundary>
      <Suspense fallback={<WorkspaceSurfaceSkeleton />}>
        <WorkspaceSurfaceReady
          orgSlug={props.orgSlug}
          workspaceSlug={props.workspaceSlug}
          conversationId={conversationId}
          paneParam={props.paneParam}
        />
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

function WorkspacePrepareFailedLayout(props: {
  orgSlug: string
  workspace: WorkspaceDetail
}) {
  const { orgSlug, workspace } = props
  const [pane, setPane] = useState<ParsedPane>({ kind: "settings" })
  const [paneCollapsed, setPaneCollapsed] = useState(false)
  const [paneWidth, setPaneWidth] = useState<number | null>(null)
  const [maximized, setMaximized] = useState(false)
  const paneOpen = !paneCollapsed

  return (
    <div className="flex h-svh min-h-0 min-w-0" data-workspace-surface="">
      <div
        className={cn(
          "flex h-full min-h-0 min-w-0 flex-1",
          maximized ? "hidden" : paneOpen ? "max-lg:hidden" : null,
        )}
      >
        <WorkspaceChatChrome
          workspace={workspace}
          title={workspace.displayName}
          headerExtra={
            paneOpen ? null : (
              <WorkspacePaneTriggers
                orgSlug={orgSlug}
                workspace={workspace}
                onOpen={(next) => {
                  setPane(next)
                  setPaneCollapsed(false)
                }}
              />
            )
          }
        >
          <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-12">
            <WorkspaceHydrateFailedBody
              orgSlug={orgSlug}
              workspace={workspace}
            />
          </div>
        </WorkspaceChatChrome>
      </div>
      {paneOpen ? (
        <WorkspacePane
          orgSlug={orgSlug}
          workspace={workspace}
          pane={pane}
          fileTabs={[]}
          previewPath={null}
          treeCollapsed
          maximized={maximized}
          width={paneWidth}
          conversationTitle={workspace.displayName}
          onPane={setPane}
          onClose={() => {
            setMaximized(false)
            setPaneCollapsed(true)
          }}
          onToggleMaximize={() => setMaximized((value) => !value)}
          onRestoreConversation={() => {
            setMaximized(false)
            if (
              typeof window !== "undefined" &&
              window.matchMedia("(max-width: 1023px)").matches
            ) {
              setPaneCollapsed(true)
            }
          }}
          onResize={setPaneWidth}
          onPreviewFile={() => {}}
          onPinFile={() => {}}
          onCloseFileTab={() => {}}
          onCloseActiveFile={() => {}}
          onToggleTree={() => {}}
        />
      ) : null}
    </div>
  )
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
      const interval = pollWhileOk(2000)(query)
      if (interval === false) return false
      const data = query.state.data
      if (!data) return false
      return workspacePrepareNeedsPoll(data) ? interval : false
    },
  })

  const conversationKey = conversationId ?? "compose"
  const chromeKey = `${orgSlug}/${workspaceSlug}/${conversationKey}:${paneParam ?? ""}`
  const initialPane = landingPane(paneParam)
  const [shownPane, setShownPane] = useState<ParsedPane | null>(initialPane)
  const [maximized, setMaximized] = useState(false)
  const [paneWidth, setPaneWidth] = useState<number | null>(null)
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  const [paneCollapsed, setPaneCollapsed] = useState(initialPane == null)
  const [fileTabs, setFileTabs] = useState<FileTabSession>({
    tabs: [],
    previewPath: null,
  })
  const [hydrated, setHydrated] = useState(false)
  const [seenChromeKey, setSeenChromeKey] = useState(chromeKey)
  const identityRef = useRef({ orgSlug, workspaceSlug, conversationId })

  const fileFromPane = shownPane?.kind === "file" ? shownPane.path : null
  const openFileTabs = tabsIncludingPanePath(fileTabs.tabs, fileFromPane)

  useEffect(() => {
    void touchWorkspace(orgSlug, workspaceSlug).then(() => {
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.list(orgSlug),
      })
    })
  }, [orgSlug, workspaceSlug, queryClient])

  useEffect(() => {
    if (!hydrated) setHydrated(true)
  }, [hydrated])

  if (hydrated && seenChromeKey !== chromeKey) {
    identityRef.current = { orgSlug, workspaceSlug, conversationId }
    setSeenChromeKey(chromeKey)
    const pane = landingPane(paneParam)
    setShownPane(pane)
    setPaneCollapsed(pane == null)
    setMaximized(false)
  }

  const navigatePaneSearch = (next: ParsedPane | null) => {
    void navigate({
      to: conversationId
        ? "/$orgSlug/ws/$workspaceSlug/$conversationId"
        : "/$orgSlug/ws/$workspaceSlug",
      params: conversationId
        ? { orgSlug, workspaceSlug, conversationId }
        : { orgSlug, workspaceSlug },
      search: (prev) => {
        const pane = next ? serializePane(next) : undefined
        if (prev.pane === pane) return prev
        return { ...prev, pane }
      },
      replace: true,
    })
  }

  const setPane = (next: ParsedPane | null, tabs = fileTabs) => {
    const pane = next ? visiblePane(next) : null
    setShownPane(pane)
    setPaneCollapsed(pane == null)
    setFileTabs(tabs)
    navigatePaneSearch(pane)
  }

  if (workspace === null) {
    return (
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
    )
  }

  if (!workspaceProjectionReady(workspace)) {
    if (workspaceHydrateView(workspace) === "failed") {
      return (
        <WorkspacePrepareFailedLayout orgSlug={orgSlug} workspace={workspace} />
      )
    }
    return <WorkspaceHydrateProgress orgSlug={orgSlug} workspace={workspace} />
  }

  return (
    <WorkspaceSurfaceLayout
      orgSlug={orgSlug}
      workspace={workspace}
      conversationId={conversationId}
      conversationTitle={conversationTitleFromList(
        queryClient,
        orgSlug,
        workspace.id,
        conversationId,
      )}
      shownPane={shownPane}
      maximized={maximized}
      paneWidth={paneWidth}
      treeCollapsed={treeCollapsed}
      paneCollapsed={paneCollapsed}
      fileTabs={openFileTabs}
      previewPath={fileTabs.previewPath}
      fileTabSession={fileTabs}
      setMaximized={setMaximized}
      setPaneWidth={setPaneWidth}
      setTreeCollapsed={setTreeCollapsed}
      setFileTabs={setFileTabs}
      setPane={setPane}
    />
  )
}

function conversationTitleFromList(
  queryClient: QueryClient,
  orgSlug: string,
  workspaceId: string,
  conversationId?: string,
) {
  if (!conversationId) return "New conversation"
  const cached = queryClient.getQueryData<{
    pages: { items: { id: string; name: string }[] }[]
  }>(workspaceKeys.conversations(orgSlug, workspaceId))
  const name = cached?.pages
    .flatMap((page) => page.items)
    .find((item) => item.id === conversationId)?.name
  return name?.trim() || "New conversation"
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
  fileTabSession: FileTabSession
  setMaximized: React.Dispatch<React.SetStateAction<boolean>>
  setPaneWidth: React.Dispatch<React.SetStateAction<number | null>>
  setTreeCollapsed: React.Dispatch<React.SetStateAction<boolean>>
  setFileTabs: React.Dispatch<React.SetStateAction<FileTabSession>>
  setPane: (next: ParsedPane | null, tabs?: FileTabSession) => void
}) {
  return <WorkspaceSurfaceColumns {...props} />
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
  fileTabSession: FileTabSession
  setMaximized: React.Dispatch<React.SetStateAction<boolean>>
  setPaneWidth: React.Dispatch<React.SetStateAction<number | null>>
  setTreeCollapsed: React.Dispatch<React.SetStateAction<boolean>>
  setFileTabs: React.Dispatch<React.SetStateAction<FileTabSession>>
  setPane: (next: ParsedPane | null, tabs?: FileTabSession) => void
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
    fileTabSession,
    setMaximized,
    setPaneWidth,
    setTreeCollapsed,
    setFileTabs,
    setPane,
  } = props

  const paneOpen = shownPane != null && !paneCollapsed
  const panePath = shownPane?.kind === "file" ? shownPane.path : null

  const collapsePane = () => {
    const nextTabs = seedFileTabSession(fileTabSession, panePath)
    setMaximized(false)
    setFileTabs(nextTabs)
    setPane(null, nextTabs)
  }

  const openFile = (path: string, pin: boolean) => {
    const seeded = seedFileTabSession(fileTabSession, panePath)
    const nextTabs = pin ? pinFile(seeded, path) : previewFile(seeded, path)
    setFileTabs(nextTabs)
    setPane({ kind: "file", path }, nextTabs)
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
                orgSlug={orgSlug}
                workspace={workspace}
                onOpen={(next) => setPane(next)}
                onExpand={
                  fileTabs.length > 0
                    ? () => {
                        setPane(
                          shownPane ?? { kind: "files" },
                          fileTabSession,
                        )
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
          conversationId={conversationId}
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
            const nextTabs = closeFileTab(fileTabSession, path)
            setFileTabs(nextTabs)
            if (shownPane.kind === "file" && shownPane.path === path) {
              setPane({ kind: "files" }, nextTabs)
            }
          }}
          onCloseActiveFile={() => {
            if (shownPane.kind === "file") {
              const nextTabs = closeFileTab(fileTabSession, shownPane.path)
              setFileTabs(nextTabs)
              setPane({ kind: "files" }, nextTabs)
            }
          }}
          onToggleTree={() => setTreeCollapsed((value) => !value)}
        />
      ) : null}
    </div>
  )
}
