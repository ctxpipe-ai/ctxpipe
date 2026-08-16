import type { Workspace } from "./types"

export function WorkspaceHydrateProgress(props: { workspace: Workspace }) {
  const { workspace } = props
  const sha = workspace.desiredSha
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center px-6 py-16">
      <div className="max-w-md">
        <p className="ctx-label text-teal-400">Workspace</p>
        <h1 className="mt-3 text-xl font-medium tracking-tight">
          Preparing {workspace.displayName}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Chat and the graph wait until the first hydrate SHA is the active
          projection. This Workspace is still importing knowledge from git.
        </p>
        <p className="mt-5 flex items-center gap-2 text-sm">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-teal-400" />
          </span>
          <span>
            Hydrate {workspace.hydrateStatus}
            {sha ? (
              <>
                {" "}
                for{" "}
                <code className="font-mono text-xs tabular-nums">
                  {sha.slice(0, 12)}
                </code>
              </>
            ) : (
              ". Waiting for a resolved tip."
            )}
          </span>
        </p>
      </div>
    </main>
  )
}
