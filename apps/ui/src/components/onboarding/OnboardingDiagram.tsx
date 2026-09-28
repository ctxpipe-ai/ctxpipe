import { IconBrandGithub, IconTerminal2 } from "@tabler/icons-react"
import type { BeatState, OnboardingView } from "./onboarding-state"

type OnboardingDiagramProps = {
  view: OnboardingView
  githubAccount: string | null
  repositories: string[]
  firstCall: { client: string | null; tool: string | null } | null
}

const PANEL: Record<BeatState, string> = {
  // The noise texture blends into the panel background, so every state has one.
  future: "border-white/5 bg-zinc-950 text-zinc-600",
  // Only the area the current step edits glows.
  current: "onb-active border-teal-400/50 bg-zinc-900 text-zinc-100",
  done: "border-white/15 bg-zinc-900 text-zinc-100",
  skipped: "border-dashed border-white/10 bg-zinc-950 text-zinc-600",
}

const WIRE: Record<BeatState, string> = {
  future: "stroke-zinc-900",
  current: "onb-wire-flow stroke-teal-400",
  done: "stroke-teal-400/55",
  skipped: "stroke-zinc-800 [stroke-dasharray:2_6]",
}

const STATUS_WORD = {
  source: {
    future: "not connected",
    current: "waiting",
    done: "ingesting",
    skipped: "skipped",
  },
  agent: {
    future: "not connected",
    current: "listening",
    done: "connected",
    skipped: "skipped",
  },
} satisfies Record<string, Record<BeatState, string>>

const LATER_SOURCES = ["Linear", "Notion", "Slack", "Confluence"]

export function OnboardingDiagram({
  view,
  githubAccount,
  repositories,
  firstCall,
}: OnboardingDiagramProps) {
  const { beats } = view
  const agentWire =
    beats.agent === "current" && !view.hasSource ? "future" : beats.agent
  const shownRepos = repositories.slice(0, 2)
  const moreRepos = repositories.length - shownRepos.length

  const layers = [
    {
      index: "01",
      name: "Perception",
      title: "Observe & ingest",
      metric: view.indexingLabel,
      lit: view.hasSource,
    },
    {
      index: "02",
      name: "Knowledge",
      title: "Reason & remember",
      metric: view.hasSource ? "org-scoped graph" : "empty",
      lit: view.hasSource,
    },
    {
      index: "03",
      name: "Intelligence",
      title: "Serve over MCP",
      metric: firstCall?.tool ?? "ctx_advisor",
      lit: beats.agent === "done",
    },
  ]

  return (
    <figure className="onb-in-2 m-0">
      <div
        aria-hidden
        className={`onb-diagram-grid relative border bg-zinc-950 p-5 pt-8 transition-[border-color,box-shadow] duration-500 ${
          beats.org === "current"
            ? "onb-active border-teal-400/50"
            : "border-white/10"
        }`}
      >
        <span
          className={`absolute -top-2.5 left-6 bg-zinc-950 px-2 font-mono text-sm transition-colors duration-500 ${
            beats.org === "done" ? "text-zinc-100" : "text-zinc-400"
          }`}
        >
          {view.frameLabel}
          {beats.org === "current" ? (
            <span className="onb-caret ml-px text-teal-400">|</span>
          ) : null}
        </span>

        <div className="relative grid min-h-120 grid-cols-[minmax(0,12rem)_3rem_minmax(0,1fr)_3rem_minmax(0,13rem)] items-stretch">
          <section
            className={`onb-noise flex flex-col gap-3 border p-4 transition-[border-color,background-color,box-shadow] duration-500 ${PANEL[beats.source]}`}
          >
            <PanelHeader
              label="Sources"
              beat={beats.source}
              word={STATUS_WORD.source[beats.source]}
            />
            <div className="flex items-center gap-2 text-sm font-medium">
              <IconBrandGithub className="size-4" aria-hidden />
              <span>GitHub</span>
            </div>
            <span className="-mt-2 truncate font-mono text-xs opacity-80">
              {githubAccount ??
                (beats.source === "skipped" ? "skipped" : "not connected")}
            </span>
            {shownRepos.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {shownRepos.map((repo) => (
                  <li
                    key={repo}
                    className="truncate border border-white/10 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-200"
                  >
                    {repo}
                  </li>
                ))}
                {moreRepos > 0 ? (
                  <li className="font-mono text-xs text-zinc-500">
                    +{moreRepos} more
                  </li>
                ) : null}
              </ul>
            ) : (
              <span
                className={`border px-2 py-1 font-mono text-xs ${
                  beats.source === "current"
                    ? "border-dashed border-zinc-600 text-zinc-500"
                    : "border-white/5 text-zinc-700"
                }`}
              >
                repository
              </span>
            )}
            <ul className="m-0 mt-auto flex list-none flex-col gap-1 p-0">
              {LATER_SOURCES.map((source) => (
                <li
                  key={source}
                  className="border border-dashed border-white/5 px-2 py-1 text-xs text-zinc-700"
                >
                  {source}
                </li>
              ))}
            </ul>
          </section>

          <Wire beat={beats.source} rows={1} />

          <section
            className={`relative flex flex-col gap-2 border border-dashed p-3 pt-5 transition-colors duration-500 ${
              view.hasSource ? "border-white/15" : "border-white/10"
            }`}
          >
            <span
              className={`absolute -top-2.5 left-4 border bg-zinc-950 px-2 font-mono text-xs uppercase tracking-wider transition-colors duration-500 ${
                view.hasSource
                  ? "border-teal-400/30 text-teal-400"
                  : "border-white/10 text-zinc-500"
              }`}
            >
              ctx| · context layer
            </span>
            {layers.map((layer) => (
              <article
                key={layer.index}
                className={`onb-noise flex flex-1 flex-col gap-1 border p-3 transition-colors duration-500 ${
                  layer.lit
                    ? "border-white/15 bg-zinc-900"
                    : "border-white/5 bg-zinc-950"
                }`}
              >
                <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-zinc-500">
                  <span
                    className={`inline-flex size-5 items-center justify-center border font-mono ${
                      layer.lit
                        ? "border-teal-400/45 text-teal-400"
                        : "border-white/10 text-zinc-600"
                    }`}
                  >
                    {layer.index}
                  </span>
                  {layer.name}
                </div>
                <span
                  className={`text-sm font-medium ${
                    layer.lit ? "text-zinc-100" : "text-zinc-600"
                  }`}
                >
                  {layer.title}
                </span>
                <span
                  className={`mt-auto font-mono text-xs ${
                    layer.lit ? "text-teal-400" : "text-zinc-600"
                  }`}
                >
                  {layer.metric}
                </span>
              </article>
            ))}
          </section>

          <Wire beat={agentWire} rows={2} />

          <section
            className={`onb-noise flex flex-col gap-3 border p-4 transition-[border-color,background-color,box-shadow] duration-500 ${PANEL[beats.agent]}`}
          >
            <PanelHeader
              label="Agents"
              beat={beats.agent}
              word={STATUS_WORD.agent[beats.agent]}
            />
            <div className="flex items-center gap-2 text-sm font-medium">
              <IconTerminal2 className="size-4" aria-hidden />
              <span className="truncate">
                {firstCall?.client ?? "Your agent"}
              </span>
            </div>
            {firstCall ? (
              <div className="relative flex flex-col gap-1 border border-white/10 bg-zinc-950 p-2 pl-3 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-teal-400/55">
                <span className="text-xs uppercase tracking-wider text-zinc-500">
                  First call
                </span>
                <span className="truncate font-mono text-xs text-teal-400">
                  {firstCall.tool ?? "initialize"}
                </span>
              </div>
            ) : (
              <span
                className={`border px-2 py-1 text-xs ${
                  beats.agent === "current"
                    ? "border-dashed border-zinc-600 text-zinc-500"
                    : "border-white/5 text-zinc-700"
                }`}
              >
                first call appears here
              </span>
            )}
          </section>
        </div>
      </div>
      <figcaption
        aria-live="polite"
        className="mt-4 max-w-prose text-sm text-muted-foreground"
      >
        {view.caption}
      </figcaption>
    </figure>
  )
}

function PanelHeader({
  label,
  beat,
  word,
}: {
  label: string
  beat: BeatState
  word: string
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
      <span className="text-xs uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      <span
        className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs ${
          beat === "done" || beat === "current"
            ? "text-teal-400"
            : "text-zinc-600"
        }`}
      >
        {beat === "done" || beat === "current" ? (
          <span className="ctx-indexing-dot" />
        ) : null}
        {word}
      </span>
    </div>
  )
}

function Wire({ beat, rows }: { beat: BeatState; rows: 1 | 2 }) {
  return (
    <svg
      className="h-full w-full"
      viewBox="0 0 40 100"
      preserveAspectRatio="none"
      role="presentation"
    >
      {rows === 1 ? (
        <line
          x1="0"
          y1="50"
          x2="40"
          y2="50"
          vectorEffect="non-scaling-stroke"
          className={`fill-none transition-[stroke] duration-500 [stroke-width:1.25] ${WIRE[beat]}`}
        />
      ) : (
        <>
          <line
            x1="40"
            y1="46"
            x2="0"
            y2="46"
            vectorEffect="non-scaling-stroke"
            className={`fill-none transition-[stroke] duration-500 [stroke-width:1.25] ${WIRE[beat]}`}
          />
          <line
            x1="0"
            y1="54"
            x2="40"
            y2="54"
            vectorEffect="non-scaling-stroke"
            className={`fill-none transition-[stroke] duration-500 [stroke-width:1.25] ${WIRE[beat]}`}
          />
        </>
      )}
    </svg>
  )
}
