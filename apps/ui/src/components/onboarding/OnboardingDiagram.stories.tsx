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
  activeCount: 1,
  readyCount: 2,
  failedCount: 0,
  stepLabel: "embedding 7/22",
}

function render(facts: OnboardingFacts) {
  return (
    <div className="max-w-4xl bg-zinc-950 p-10">
      <OnboardingDiagram
        view={deriveOnboardingView(facts)}
        githubAccount={facts.github.installed ? "acme" : null}
        repositories={facts.github.repositories}
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
