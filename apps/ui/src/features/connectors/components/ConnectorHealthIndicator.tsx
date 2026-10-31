import { type ConnectorHealth, connectorHealthLabel } from "../connectorHealth"

const failureTone = {
  text: "text-red-400",
  dot: "bg-red-400",
  pulse: true,
} as const

const TONE: Record<
  ConnectorHealth,
  { text: string; dot: string; pulse: boolean }
> = {
  checking: {
    text: "text-muted-foreground",
    dot: "bg-zinc-500",
    pulse: true,
  },
  setup_pending: {
    text: "text-muted-foreground",
    dot: "bg-zinc-500",
    pulse: false,
  },
  awaiting_merge: {
    text: "text-muted-foreground",
    dot: "bg-zinc-500",
    pulse: false,
  },
  reconnect: {
    text: "text-amber-400",
    dot: "bg-amber-400",
    pulse: false,
  },
  syncing: {
    text: "text-muted-foreground",
    dot: "bg-zinc-500",
    pulse: true,
  },
  connected: {
    text: "text-emerald-400",
    dot: "bg-emerald-400",
    pulse: true,
  },
  couldnt_load: failureTone,
  sync_failed: failureTone,
  config_failed: failureTone,
}

export function ConnectorHealthIndicator({
  health,
  label,
}: {
  health: ConnectorHealth
  /** The text in place of the health name, for example "2 connected". */
  label?: string
}) {
  const tone = TONE[health]
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 font-mono text-xs ${tone.text}`}
    >
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${tone.dot} ${
          tone.pulse ? "ctx-status-pulse" : ""
        }`}
      />
      {label ?? connectorHealthLabel(health)}
    </span>
  )
}
