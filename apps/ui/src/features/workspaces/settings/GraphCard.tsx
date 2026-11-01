import { Button } from "@/components/ui/Button"
import { InlineAlert } from "@/components/ui/InlineAlert"
import { Link as TextLink } from "@/components/ui/Link"
import { formatElapsed } from "@/features/workspace-upgrades/upgrade-progress"
import { useNow } from "@/lib/useNow"
import { cn } from "@/lib/utils"

import type { IngestionItem } from "../ingestion"
import {
  skippedFileCopy,
  skippedFileFixable,
  skippedFilesFixPrompt,
} from "../skipped-files"
import type { WorkspaceDetail } from "../types"
import { SettingsCard } from "./SettingsCard"

/** Does the knowledge graph need the user, and does ctxpipe work on it now. */
export function graphStatus(
  workspace: WorkspaceDetail,
  hydrate: IngestionItem | null,
) {
  return {
    needsYou:
      workspace.hydrateStatus === "failed" ||
      (workspace.skippedFiles?.length ?? 0) > 0,
    working: hydrate !== null || workspace.hydrateStatus === "running",
  }
}

/**
 * The knowledge graph of the Workspace: is it loaded, does ctxpipe index the
 * newest commit, where do answers come from while a new repository loads,
 * and which files it skipped.
 */
export function GraphCard(props: {
  workspace: WorkspaceDetail
  /** The hydrate of the newest commit that runs now. */
  hydrate: IngestionItem | null
  /** Opens a Workspace file in the Files pane. */
  onOpenFile: (path: string) => void
  /** Opens the Workspace chat with this prompt in the composer. */
  onFixWithAgent?: ((prompt: string) => void) | undefined
}) {
  const { workspace, hydrate, onFixWithAgent } = props
  const skipped = workspace.skippedFiles ?? []
  const failed = workspace.hydrateStatus === "failed"
  const now = useNow(hydrate !== null)
  const projectionLag =
    workspace.activeProjectionUrl &&
    workspace.activeProjectionUrl !== workspace.workspaceRepositoryUrl
      ? workspace.activeProjectionUrl
      : null
  return (
    <SettingsCard
      part="graph"
      needsYou={graphStatus(workspace, hydrate).needsYou}
    >
      <div className="flex flex-col gap-3">
        {failed ? (
          <InlineAlert variant="error" title="The knowledge graph did not load">
            {workspace.hydrateError ?? "ctxpipe gives no reason."}
          </InlineAlert>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                workspace.hydrateStatus === "ready"
                  ? "bg-teal-400"
                  : "ctx-status-pulse bg-zinc-400",
              )}
            />
            {workspace.hydrateStatus === "ready"
              ? "The knowledge graph is loaded."
              : workspace.hydrateStatus === "running"
                ? "ctxpipe loads the knowledge graph now."
                : "The knowledge graph waits to load."}
          </p>
        )}
        {hydrate ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <span
              aria-hidden
              className="ctx-status-pulse size-1.5 shrink-0 rounded-full bg-teal-400"
            />
            Indexing the newest commit…
            <span className="text-xs tabular-nums">
              {formatElapsed(hydrate.startedAt, now)}
            </span>
          </p>
        ) : null}
        {projectionLag ? (
          <p className="text-sm text-muted-foreground">
            Answers still come from{" "}
            <code className="font-mono text-xs text-foreground">
              {projectionLag}
            </code>{" "}
            until the new repository finishes loading.
          </p>
        ) : null}
        {skipped.length ? (
          <div className="mt-1 border-t border-white/[0.06] pt-3">
            <div role="alert">
              <h3 className="text-sm text-foreground">
                ctxpipe skipped {skipped.length}{" "}
                {skipped.length === 1 ? "file" : "files"}
              </h3>
              <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">
                Chat, MCP, search, and the graph do not use these files.
                {skipped.some((file) => file.source !== "legacy-overlay")
                  ? " Fix each file that is in Git and push the change to the default branch."
                  : ""}
              </p>
            </div>
            <ul className="mt-2 flex flex-col divide-y divide-white/[0.06]">
              {skipped.map((file) => (
                <li
                  key={file.path}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2.5"
                >
                  <div className="min-w-0">
                    {/* A legacy overlay path is not in Git, so the Files pane cannot open it. */}
                    {file.source === "legacy-overlay" ? (
                      <span className="block truncate font-mono text-xs text-foreground">
                        {file.path}
                      </span>
                    ) : (
                      <TextLink
                        onPress={() => props.onOpenFile(file.path)}
                        className="block cursor-pointer truncate font-mono text-xs"
                      >
                        {file.path}
                      </TextLink>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {skippedFileCopy(file)}
                    </p>
                  </div>
                  {/* Only front matter in a file of Git is for the agent to fix. */}
                  {onFixWithAgent && skippedFileFixable(file) ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="shrink-0"
                      aria-label={`Fix ${file.path} using agent`}
                      onPress={() =>
                        onFixWithAgent(skippedFilesFixPrompt([file]))
                      }
                    >
                      Fix using agent
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </SettingsCard>
  )
}
