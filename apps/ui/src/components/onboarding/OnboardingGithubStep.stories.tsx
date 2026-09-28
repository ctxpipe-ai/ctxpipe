import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, fn, within } from "storybook/test"
import { OnboardingGithubStep } from "./OnboardingGithubStep"

function repo(id: number, name: string) {
  return {
    id,
    full_name: `acme/${name}`,
    name,
    html_url: `https://github.com/acme/${name}`,
    clone_url: `https://github.com/acme/${name}.git`,
    created_at: null,
    pushed_at: null,
    default_branch: "main",
  }
}

function githubHandlers(repositories: ReturnType<typeof repo>[]) {
  return [
    http.get(
      ({ request }) =>
        new URL(request.url).pathname === "/acme/api/v1/github/installation",
      () =>
        HttpResponse.json({
          id: "github_connection_1",
          appSlug: "ctxpipe-agent",
          accountSlug: "acme",
        }),
    ),
    http.get(
      ({ request }) =>
        new URL(request.url).pathname ===
        "/acme/api/v1/github/installation/repositories",
      () =>
        HttpResponse.json({
          repositories,
          hasMore: false,
          repositorySelection: "selected",
          manageUrl: null,
        }),
    ),
  ]
}

const meta = {
  title: "Onboarding/GithubStep",
  component: OnboardingGithubStep,
  args: {
    orgSlug: "acme",
    hasInstallation: true,
    // Stories start after indexing began, so nothing is saved on mount.
    alreadyIndexed: true,
    onRepositoriesQueued: fn(),
    onContinue: fn(),
    onBack: fn(),
    onSkip: fn(),
  },
  decorators: [
    (Story) => (
      <div className="max-w-md bg-zinc-950 p-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof OnboardingGithubStep>

export default meta

type Story = StoryObj<typeof meta>

/** Indexing runs on its own; Continue is the one primary action. */
export const SharedSelection: Story = {
  parameters: {
    msw: {
      handlers: {
        page: githubHandlers([repo(1, "api"), repo(2, "web")]),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      await canvas.findByRole("button", { name: "Continue" }),
    ).toBeVisible()
    await expect(
      canvas.getByRole("link", { name: /create one on github/i }),
    ).toBeVisible()
  },
}

/** A shared ctxpipe-context repository is used without asking. */
export const ContextRepositoryFound: Story = {
  parameters: {
    msw: {
      handlers: {
        page: githubHandlers([
          repo(1, "api"),
          repo(2, "web"),
          repo(3, "ctxpipe-context"),
        ]),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      await canvas.findByText("acme/ctxpipe-context", { selector: "code" }),
    ).toBeVisible()
  },
}
