import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { McpOnboardingSlide } from "@/components/onboarding/McpOnboardingSlide"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"

const orgSlug = "acme"

const mcpSnippet = `{
  "mcpServers": {
    "ctxpipe": {
      "type": "streamable-http",
      "url": "https://app.ctxpipe.ai/mcp?orgSlug=${orgSlug}"
    }
  }
}`

const storyRepo = {
  id: 101,
  full_name: "acme/service",
  name: "service",
  html_url: "https://github.com/acme/service",
  clone_url: "https://github.com/acme/service.git",
}

const matchSetup = ({ request }: { request: Request }) =>
  new URL(request.url).pathname ===
  `/${orgSlug}/api/v1/github/installation/setup`

const matchRepos = ({ request }: { request: Request }) => {
  const u = new URL(request.url)
  const p = u.pathname.replace(/\/$/, "") || "/"
  return p === `/${orgSlug}/api/v1/github/installation/repositories`
}

const matchPreview = ({ request }: { request: Request }) =>
  new URL(request.url).pathname ===
  `/${orgSlug}/api/v1/github/installation/mcp-config-preview`

const matchPrs = ({ request }: { request: Request }) =>
  new URL(request.url).pathname ===
  `/${orgSlug}/api/v1/github/installation/mcp-config-prs`

const autoWizardMsw = [
  http.get(matchSetup, () => new HttpResponse(null, { status: 404 })),
  http.get(matchRepos, () =>
    HttpResponse.json({ repositories: [storyRepo], hasMore: false }),
  ),
  http.post(matchPreview, () =>
    HttpResponse.json({
      files: [
        {
          repository: "acme/service",
          path: ".cursor/mcp.json",
          exists: false,
          existingUtf8: null,
          mergedUtf8: "{}",
        },
      ],
    }),
  ),
  http.post(matchPrs, () =>
    HttpResponse.json({
      pullRequests: [
        {
          repository: "acme/service",
          pullRequestUrl: "https://github.com/acme/service/pull/1",
        },
      ],
      failures: [],
    }),
  ),
]

const meta = {
  title: "Components/Onboarding/Slides/McpOnboarding",
  component: McpOnboardingSlide,
  decorators: [
    (Story) => (
      <div className="max-w-xl rounded-none border border-border bg-zinc-950 p-8 text-left">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
  args: {
    orgSlug,
    mcpSnippet,
    onContinue: fn(),
    onSkip: fn(),
  },
} satisfies Meta<typeof McpOnboardingSlide>

export default meta

type Story = StoryObj<typeof meta>

export const ChooseGithubDisconnected: Story = {
  args: {
    hasGithubInstallation: false,
  },
}

export const ChooseGithubConnected: Story = {
  args: {
    hasGithubInstallation: true,
  },
}

export const ManualSnippet: Story = {
  args: {
    hasGithubInstallation: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /install manually/i }),
    )
    await waitFor(() =>
      expect(
        canvas.getByText(/paste this into your mcp client configuration/i),
      ).toBeVisible(),
    )
    expect(canvas.getByText(/ctxpipe/i)).toBeVisible()
  },
}

export const AutoOpensWizard: Story = {
  args: {
    hasGithubInstallation: true,
  },
  parameters: {
    msw: {
      handlers: {
        page: autoWizardMsw,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /open prs for me/i }),
    )
    await waitFor(() =>
      expect(canvas.getByText(/1\. choose your agents/i)).toBeVisible(),
    )
  },
}
