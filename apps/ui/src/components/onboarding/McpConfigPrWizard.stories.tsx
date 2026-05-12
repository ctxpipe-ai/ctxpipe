import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { McpConfigPrWizard } from "@/components/onboarding/McpConfigPrWizard"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"

const orgSlug = "acme"

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

const githubSetup404 = http.get(
  matchSetup,
  () => new HttpResponse(null, { status: 404 }),
)

const githubReposOk = http.get(matchRepos, () =>
  HttpResponse.json({ repositories: [storyRepo], hasMore: false }),
)

const githubReposLoading = http.get(matchRepos, async () => {
  await delay("infinite")
  return HttpResponse.json({ repositories: [storyRepo], hasMore: false })
})

const githubReposEmpty = http.get(matchRepos, () =>
  HttpResponse.json({ repositories: [], hasMore: false }),
)

const githubReposError = http.get(matchRepos, async () => {
  await delay("real")
  return HttpResponse.json({ error: "GitHub unavailable" }, { status: 500 })
})

const previewOk = http.post(matchPreview, async () =>
  HttpResponse.json({
    files: [
      {
        repository: "acme/service",
        path: ".cursor/mcp.json",
        exists: false,
        existingUtf8: null,
        mergedUtf8: '{\n  "mcpServers": {\n    "ctxpipe": {}\n  }\n}',
      },
    ],
  }),
)

const previewLoading = http.post(matchPreview, async () => {
  await delay("infinite")
  return HttpResponse.json({
    files: [
      {
        repository: "acme/service",
        path: ".cursor/mcp.json",
        exists: false,
        existingUtf8: null,
        mergedUtf8: '{\n  "mcpServers": {\n    "ctxpipe": {}\n  }\n}',
      },
    ],
  })
})

const previewError = http.post(matchPreview, async () => {
  await delay("real")
  return HttpResponse.json({ error: "Preview failed" }, { status: 500 })
})

const prsOk = http.post(matchPrs, () =>
  HttpResponse.json({
    pullRequests: [
      {
        repository: "acme/service",
        pullRequestUrl: "https://github.com/acme/service/pull/42",
      },
    ],
    failures: [],
  }),
)

const prsPartial = http.post(matchPrs, () =>
  HttpResponse.json({
    pullRequests: [],
    failures: [
      { repository: "acme/service", error: "Branch protection blocked push" },
    ],
  }),
)

const wizardBaseMsw = [githubSetup404, githubReposOk, previewOk, prsOk]

const meta = {
  title: "Components/Onboarding/Mcp/ConfigPrWizard",
  component: McpConfigPrWizard,
  decorators: [
    (Story) => (
      <div className="max-w-3xl rounded-none border border-border bg-zinc-950 p-6 text-left">
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
    hasGithubInstallation: true,
    variant: "onboarding" as const,
    onContinue: fn(),
    onBackToModeChoice: fn(),
  },
} satisfies Meta<typeof McpConfigPrWizard>

export default meta

type Story = StoryObj<typeof meta>

export const ReposLoading: Story = {
  args: {},
  parameters: {
    msw: {
      handlers: {
        page: [githubSetup404, githubReposLoading, previewOk, prsOk],
      },
    },
    docs: {
      description: {
        story:
          'Repository list uses `delay("infinite")` — open step 2 to see a sustained “Loading repositories” state.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /2\. choose repositories/i }),
    )
    await waitFor(() =>
      expect(canvas.getByText(/loading repositories/i)).toBeVisible(),
    )
  },
}

export const ReposEmpty: Story = {
  args: {},
  parameters: {
    msw: {
      handlers: {
        page: [githubSetup404, githubReposEmpty, previewOk, prsOk],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /2\. choose repositories/i }),
    )
    await waitFor(() =>
      expect(
        canvas.getByText(/no repositories returned for this installation yet/i),
      ).toBeVisible(),
    )
  },
}

export const ReposError: Story = {
  args: {},
  parameters: {
    msw: {
      handlers: {
        page: [githubSetup404, githubReposError, previewOk, prsOk],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /2\. choose repositories/i }),
    )
    await waitFor(() =>
      expect(canvas.getByText(/github unavailable/i)).toBeVisible(),
    )
  },
}

export const PreviewLoading: Story = {
  args: {},
  parameters: {
    msw: {
      handlers: {
        page: [githubSetup404, githubReposOk, previewLoading, prsOk],
      },
    },
    docs: {
      description: {
        story:
          'Preview POST uses `delay("infinite")` after repos are selected — expand step 3 to see “Loading code changes” persist.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /2\. choose repositories/i }),
    )
    await waitFor(() => expect(canvas.getByText("acme/service")).toBeVisible())
    await userEvent.click(
      canvas.getByRole("checkbox", { name: /acme\/service/i }),
    )
    await userEvent.click(
      canvas.getByRole("button", { name: /3\. show changes/i }),
    )
    await waitFor(() =>
      expect(canvas.getByText(/loading code changes/i)).toBeVisible(),
    )
  },
}

export const PreviewError: Story = {
  args: {},
  parameters: {
    msw: {
      handlers: {
        page: [githubSetup404, githubReposOk, previewError, prsOk],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /2\. choose repositories/i }),
    )
    await waitFor(() => expect(canvas.getByText("acme/service")).toBeVisible())
    await userEvent.click(
      canvas.getByRole("checkbox", { name: /acme\/service/i }),
    )
    await userEvent.click(
      canvas.getByRole("button", { name: /3\. show changes/i }),
    )
    await waitFor(() =>
      expect(canvas.getByText(/preview failed/i)).toBeVisible(),
    )
  },
}

export const RaisePrsSuccess: Story = {
  args: {},
  parameters: {
    msw: {
      handlers: {
        page: wizardBaseMsw,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /2\. choose repositories/i }),
    )
    await waitFor(() => expect(canvas.getByText("acme/service")).toBeVisible())
    await userEvent.click(
      canvas.getByRole("checkbox", { name: /acme\/service/i }),
    )
    await userEvent.click(
      canvas.getByRole("button", { name: /3\. show changes/i }),
    )
    await waitFor(() =>
      expect(canvas.getByText(".cursor/mcp.json")).toBeVisible(),
    )
    const raiseBtn = canvas.getByRole("button", {
      name: /raise pull requests/i,
    })
    await waitFor(() => expect(raiseBtn).toBeEnabled(), { timeout: 5000 })
    await userEvent.click(raiseBtn)
    await waitFor(() =>
      expect(
        canvas.getByRole("link", { name: "acme/service" }),
      ).toHaveAttribute("href", "https://github.com/acme/service/pull/42"),
    )
  },
}

export const RaisePrsPartialFailure: Story = {
  args: {},
  parameters: {
    msw: {
      handlers: {
        page: [githubSetup404, githubReposOk, previewOk, prsPartial],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /2\. choose repositories/i }),
    )
    await waitFor(() => expect(canvas.getByText("acme/service")).toBeVisible())
    await userEvent.click(
      canvas.getByRole("checkbox", { name: /acme\/service/i }),
    )
    await userEvent.click(
      canvas.getByRole("button", { name: /3\. show changes/i }),
    )
    await waitFor(() =>
      expect(canvas.getByText(".cursor/mcp.json")).toBeVisible(),
    )
    const raiseBtn = canvas.getByRole("button", {
      name: /raise pull requests/i,
    })
    await waitFor(() => expect(raiseBtn).toBeEnabled(), { timeout: 5000 })
    await userEvent.click(raiseBtn)
    await waitFor(() =>
      expect(canvas.getByText(/branch protection blocked push/i)).toBeVisible(),
    )
  },
}

export const StandaloneWithCancel: Story = {
  args: {
    variant: "standalone",
    onCancel: fn(),
    onContinue: undefined,
  },
  parameters: {
    msw: {
      handlers: {
        page: wizardBaseMsw,
      },
    },
  },
}
