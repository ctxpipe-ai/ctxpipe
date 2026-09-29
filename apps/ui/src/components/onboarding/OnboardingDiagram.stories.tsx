import type { Meta, StoryObj } from "@storybook/react-vite"
import { OnboardingDiagram } from "./OnboardingDiagram"
import { deriveOnboardingView, type OnboardingFacts } from "./onboarding-state"

const base: OnboardingFacts = {
  orgSlug: "acme-engineering",
  typedSlug: "",
  isJoiner: false,
  github: {
    installed: false,
    skipped: false,
    repositories: [],
    queued: false,
    continued: false,
    activeCount: 0,
    readyCount: 0,
    failedCount: 0,
    stepLabel: null,
  },
  agent: { firstCall: null, skipped: false },
}

const indexing: OnboardingFacts["github"] = {
  installed: true,
  skipped: false,
  repositories: ["acme/api", "acme/web", "acme/infra"],
  queued: true,
  continued: true,
  activeCount: 1,
  readyCount: 2,
  failedCount: 0,
  stepLabel: "embedding 7/22",
}

function render(facts: OnboardingFacts) {
  const view = deriveOnboardingView(facts)
  return (
    <div className="max-w-4xl bg-zinc-950 p-10">
      <OnboardingDiagram
        view={view}
        editing={view.current}
        githubAccount={facts.github.installed ? "acme" : null}
        githubInstalled={facts.github.installed}
        repositories={facts.github.repositories}
        progress={facts.github.repositories.map((name, index) => ({
          name,
          label:
            index === 0 && facts.github.stepLabel
              ? facts.github.stepLabel
              : facts.github.activeCount > 0
                ? "queued"
                : "indexed",
          fraction:
            index === 0 && facts.github.activeCount > 0
              ? 7 / 22
              : facts.github.activeCount > 0
                ? null
                : 1,
        }))}
        firstCall={facts.agent.firstCall}
      />
    </div>
  )
}

const meta = {
  title: "Onboarding/Diagram",
  component: OnboardingDiagram,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof OnboardingDiagram>

export default meta

type Story = StoryObj<typeof meta>

// `args` is unused: each state renders from facts so it matches the route.
const noArgs = {} as Story["args"]

/** Page load, no organisation yet: the frame waits for a slug. */
export const Arrival: Story = {
  args: noArgs,
  render: () => render({ ...base, orgSlug: null, typedSlug: "acme-eng" }),
}

/** Org created: the source beat is current and its wire moves. */
export const OrganisationCreated: Story = {
  args: noArgs,
  render: () => render(base),
}

/** GitHub connected, repository list on its way: the bouncing line. */
export const ReadingRepositories: Story = {
  args: noArgs,
  render: () =>
    render({ ...base, github: { ...base.github, installed: true } }),
}

/** First repository queued: the middle is live status, the agent beat moves. */
export const Indexing: Story = {
  args: noArgs,
  render: () => render({ ...base, github: indexing }),
}

/** GitHub skipped: the source is dark and the agent waits without motion. */
export const GithubSkipped: Story = {
  args: noArgs,
  render: () => render({ ...base, github: { ...base.github, skipped: true } }),
}

/** First MCP call recorded: nothing is current, so nothing moves. */
export const Complete: Story = {
  args: noArgs,
  render: () =>
    render({
      ...base,
      github: { ...indexing, activeCount: 0, readyCount: 3, stepLabel: null },
      agent: {
        firstCall: { client: "claude-code", tool: "ctx_advisor" },
        skipped: false,
      },
    }),
}
