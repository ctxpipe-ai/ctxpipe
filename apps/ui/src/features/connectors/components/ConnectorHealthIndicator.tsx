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
  // The user must merge a source pull request: the color of a step that
  // needs the user, with a pulse while ctxpipe waits for the merge.
  awaiting_merge: {
    text: "text-amber-400",
    dot: "bg-amber-400",
    pulse: true,
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
}: {
  health: ConnectorHealth
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
      {connectorHealthLabel(health)}
    </span>
  )
}
