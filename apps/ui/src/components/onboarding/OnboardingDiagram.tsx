import { IconBrandGithub, IconTerminal2 } from "@tabler/icons-react"
import { GrowingGraph } from "./GrowingGraph"
import type {
  BeatState,
  OnboardingStepId,
  OnboardingView,
} from "./onboarding-state"

type OnboardingDiagramProps = {
  view: OnboardingView
  /** The step open on the left; only its area glows. */
  editing: OnboardingStepId | null
  githubAccount: string | null
  /** GitHub is installed; the loader runs until repositories are queued. */
  githubInstalled: boolean
  repositories: string[]
  /** Live per-repository progress for the Perception layer. */
  progress: Array<{ name: string; label: string; fraction: number | null }>
  firstCall: { client: string | null; tool: string | null } | null
}

const PANEL: Record<BeatState, string> = {
  // The noise texture blends into the panel background, so every state has one.
  future: "border-white/5 bg-zinc-950 text-zinc-600",
  current: "border-white/15 bg-zinc-900 text-zinc-100",
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

// One tile however many connectors ship; they are added after setup.
const LATER_SOURCES = "Linear, Notion, Slack, Confluence, PagerDuty and more"

// Only the area the open step edits glows.
const EDITING = "onb-active border-teal-400/50"

export function OnboardingDiagram({
  view,
  editing,
  githubAccount,
  githubInstalled,
  repositories,
  progress,
  firstCall,
}: OnboardingDiagramProps) {
  const { beats } = view
  const agentWire =
    beats.agent === "current" && !view.hasSource ? "future" : beats.agent
  const shownRepos = repositories.slice(0, 2)
  const moreRepos = repositories.length - shownRepos.length

  const shownProgress = progress.slice(0, 3)
  const moreProgress = progress.length - shownProgress.length
  const layers = [
    {
      index: "01",
      name: "Perception",
      title: "Observe & ingest",
      metric: view.indexingLabel,
      lit: view.hasSource,
      grow: false,
      canvas: null,
      // Real ingestion: each repository's live step from the backend.
      body:
        shownProgress.length > 0 ? (
          <ul className="m-0 mt-auto flex list-none flex-col gap-1.5 p-0">
            {shownProgress.map((repo) => (
              <li key={repo.name} className="flex flex-col gap-1">
                <span className="flex items-baseline justify-between gap-2 font-mono text-xs">
                  <span className="truncate text-zinc-300">{repo.name}</span>
                  <span className="shrink-0 text-teal-400">{repo.label}</span>
                </span>
                <span className="relative h-px w-full bg-white/10">
                  {repo.fraction === null ? null : (
                    <span
                      className="absolute inset-y-0 left-0 bg-teal-400/70"
                      style={{ width: `${Math.round(repo.fraction * 100)}%` }}
                    />
                  )}
                </span>
              </li>
            ))}
            {moreProgress > 0 ? (
              <li className="font-mono text-xs text-zinc-500">
                +{moreProgress} more
              </li>
            ) : null}
          </ul>
        ) : null,
    },
    {
      index: "02",
      name: "Knowledge",
      title: "Reason & remember",
      metric: view.hasSource ? "org-scoped graph" : "empty",
      lit: view.hasSource,
      grow: view.hasSource,
      // Mocked: a graph grows once repositories are queued; before that, a
      // loader while GitHub hands over the repository list.
      // Between the heading and the metric line, so text stays clear.
      canvas: view.hasSource ? (
        <div className="absolute inset-x-3 top-16 bottom-8">
          <GrowingGraph />
        </div>
      ) : null,
      body:
        !view.hasSource && githubInstalled ? (
          <span className="mt-auto flex flex-col gap-2">
            <span className="onb-line-loader" />
            <span className="font-mono text-xs text-zinc-500">
              reading repositories
            </span>
          </span>
        ) : null,
    },
    {
      index: "03",
      name: "Intelligence",
      title: "Serve over MCP",
      metric: firstCall?.tool ?? "ctx_advisor",
      lit: beats.agent === "done",
      grow: false,
      canvas: null,
      body: null,
    },
  ]

  return (
    <figure className="onb-in-2 m-0 flex h-full flex-col">
      <div
        aria-hidden
        className={`onb-diagram-grid relative flex min-h-0 flex-1 flex-col border bg-zinc-950 p-5 pt-8 transition-[border-color,box-shadow] duration-500 ${
          editing === "org" ? EDITING : "border-white/10"
        }`}
      >
        <span
          className={`absolute -top-2.5 left-6 bg-zinc-950 px-2 font-mono text-sm transition-colors duration-500 ${
            beats.org === "done"
              ? "text-zinc-100"
              : view.framePlaceholder
                ? "text-zinc-600"
                : "text-zinc-300"
          }`}
        >
          {view.frameLabel}
          {beats.org === "current" ? (
            // Dim and still: the frame mirrors the slug field, it is not
            // an input itself.
            <span className="ml-px text-zinc-600">|</span>
          ) : null}
        </span>

        <div className="relative grid min-h-120 flex-1 grid-cols-[minmax(0,12rem)_3rem_minmax(0,1fr)_3rem_minmax(0,13rem)] items-stretch">
          <section
            className={`onb-noise flex flex-col gap-3 border p-4 transition-[border-color,background-color,box-shadow] duration-500 ${PANEL[beats.source]} ${editing === "source" ? EDITING : ""}`}
          >
            <PanelHeader
              label="Sources"
              beat={beats.source}
              word={
                view.hasSource ? "ingesting" : STATUS_WORD.source[beats.source]
              }
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
            <div className="mt-auto flex flex-col gap-1 border border-dashed border-white/10 px-2 py-2">
              <span className="text-xs font-medium text-zinc-500">+ Tools</span>
              <span className="text-xs text-zinc-600">
                {LATER_SOURCES}, after setup
              </span>
            </div>
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
                className={`onb-noise relative flex flex-col gap-1 overflow-hidden border p-3 transition-[flex-grow,border-color,background-color] duration-700 ${
                  layer.grow ? "flex-[2]" : "flex-1"
                } ${
                  layer.lit
                    ? "border-white/15 bg-zinc-900"
                    : "border-white/5 bg-zinc-950"
                }`}
              >
                {layer.canvas}
                <div className="relative flex items-center gap-2 text-xs uppercase tracking-wider text-zinc-500">
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
                  className={`relative text-sm font-medium ${
                    layer.lit ? "text-zinc-100" : "text-zinc-600"
                  }`}
                >
                  {layer.title}
                </span>
                {layer.body ? (
                  <div className="relative mt-auto flex flex-col">
                    {layer.body}
                  </div>
                ) : (
                  <span
                    className={`relative mt-auto font-mono text-xs ${
                      layer.lit ? "text-teal-400" : "text-zinc-600"
                    }`}
                  >
                    {layer.metric}
                  </span>
                )}
              </article>
            ))}
          </section>

          <Wire beat={agentWire} rows={2} />

          <section
            className={`onb-noise flex flex-col gap-3 border p-4 transition-[border-color,background-color,box-shadow] duration-500 ${PANEL[beats.agent]} ${editing === "agent" ? EDITING : ""}`}
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
