import { type ConnectorHealth, connectorHealthLabel } from "../connectorHealth"

/** The dot carries the color of the state. The word stays muted. */
const DOT: Record<ConnectorHealth, { dot: string; pulse: boolean }> = {
  checking: { dot: "bg-zinc-500", pulse: true },
  setup_pending: { dot: "bg-zinc-500", pulse: false },
  awaiting_merge: { dot: "bg-zinc-500", pulse: false },
  reconnect: { dot: "bg-amber-400", pulse: false },
  syncing: { dot: "bg-zinc-500", pulse: true },
  connected: { dot: "bg-emerald-400", pulse: false },
  couldnt_load: { dot: "bg-red-400", pulse: false },
  sync_failed: { dot: "bg-red-400", pulse: false },
  config_failed: { dot: "bg-red-400", pulse: false },
}

export function ConnectorHealthIndicator({
  health,
  label,
}: {
  health: ConnectorHealth
  /** The text in place of the health name, for example "2 connected". */
  label?: string
}) {
  const tone = DOT[health]
  return (
    <span className="inline-flex min-w-0 items-center gap-2 font-mono text-xs text-muted-foreground">
      <span
        aria-hidden
        className={`size-1.5 shrink-0 rounded-full ${tone.dot} ${
          tone.pulse ? "ctx-status-pulse" : ""
        }`}
      />
      <span className="truncate">{label ?? connectorHealthLabel(health)}</span>
    </span>
  )
}
