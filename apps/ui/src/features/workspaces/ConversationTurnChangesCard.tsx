import {
  IconChevronRight,
  IconFileDiff,
  IconFolder,
  IconSelector,
} from "@tabler/icons-react"
import { useState } from "react"
import {
  Button as AriaButton,
  Disclosure,
  DisclosureGroup,
  DisclosurePanel,
} from "react-aria-components"

import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"

import { groupChangedFilesByFolder } from "./conversationDiff"
import type { ConversationTurnChanges } from "./types"
import {
  ChangedFileStatusIcon,
  LineCounts,
  TailTruncatedPath,
} from "./WorkspaceConversationDiff"

const rowButtonClassName = cn(
  "flex min-w-0 flex-1 cursor-default items-center gap-2 rounded-md px-2 py-1 text-left outline-0 hover:bg-foreground/[0.04]",
  focusVisibleClassName,
)

/** The files one turn changed, shown at the end of that turn's reply. */
export function ConversationTurnChangesCard(props: {
  changes: ConversationTurnChanges
  /** Open the Diff pane on this turn; with a path, on that file. */
  onOpenDiff: (path?: string) => void
  defaultCollapsed?: boolean
}) {
  const [collapsed, setCollapsed] = useState(props.defaultCollapsed ?? false)
  const files = props.changes.files
  const groups = groupChangedFilesByFolder(files)
  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const title = `${files.length} changed ${files.length === 1 ? "file" : "files"}`

  return (
    <section
      aria-label={title}
      className="w-full rounded-md bg-foreground/[0.03] p-2 text-sm"
    >
      <div className="flex items-center gap-3 pl-2">
        <span className="font-medium text-foreground">{title}</span>
        <LineCounts additions={additions} deletions={deletions} />
        <span className="flex-1" />
        <AriaButton
          aria-label={collapsed ? "Show changed files" : "Hide changed files"}
          aria-expanded={!collapsed}
          onPress={() => setCollapsed(!collapsed)}
          className={cn(
            "flex size-7 cursor-default items-center justify-center rounded-md text-muted-foreground outline-0 hover:bg-foreground/[0.06] hover:text-foreground",
            focusVisibleClassName,
          )}
        >
          <IconSelector className="size-4" aria-hidden />
        </AriaButton>
        <AriaButton
          onPress={() => props.onOpenDiff()}
          className={cn(
            "flex h-7 cursor-default items-center gap-1.5 rounded-md px-2 text-muted-foreground outline-0 hover:bg-foreground/[0.06] hover:text-foreground",
            focusVisibleClassName,
          )}
        >
          <IconFileDiff className="size-4" aria-hidden />
          Open diff
        </AriaButton>
      </div>
      {collapsed ? null : (
        <DisclosureGroup allowsMultipleExpanded className="mt-2">
          {groups.map((group) => (
            <Disclosure key={group.folder} id={group.folder}>
              {({ isExpanded }) => (
                <>
                  <div className="flex items-center gap-2">
                    <AriaButton slot="trigger" className={rowButtonClassName}>
                      <IconChevronRight
                        className={cn(
                          "size-4 shrink-0 text-muted-foreground transition-transform",
                          isExpanded && "rotate-90",
                        )}
                        aria-hidden
                      />
                      <IconFolder
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <TailTruncatedPath
                        path={group.folder || "./"}
                        className="text-xs text-muted-foreground"
                      />
                    </AriaButton>
                    <LineCounts
                      additions={group.additions}
                      deletions={group.deletions}
                      className="w-20 justify-end pr-2"
                    />
                  </div>
                  <DisclosurePanel>
                    <ul className="pb-1 pl-6">
                      {group.files.map((file) => (
                        <li key={file.path} className="flex items-center gap-2">
                          <AriaButton
                            aria-label={`Open diff of ${file.path}`}
                            onPress={() => props.onOpenDiff(file.path)}
                            className={rowButtonClassName}
                          >
                            <ChangedFileStatusIcon status={file.status} />
                            <span className="min-w-0 truncate font-mono text-xs text-foreground">
                              {file.path
                                .slice(group.folder.length)
                                .replace(/^\//, "")}
                            </span>
                          </AriaButton>
                          <LineCounts
                            additions={file.additions}
                            deletions={file.deletions}
                            className="w-20 justify-end pr-2"
                          />
                        </li>
                      ))}
                    </ul>
                  </DisclosurePanel>
                </>
              )}
            </Disclosure>
          ))}
        </DisclosureGroup>
      )}
    </section>
  )
}
