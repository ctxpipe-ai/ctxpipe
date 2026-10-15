import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { useState } from "react"
import { expect, userEvent, within } from "storybook/test"
import { buildkitePipelinesHandler } from "@/mocks/buildkite-handlers"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { BuildkiteScopeEditor } from "./buildkite"

/** The editor with the scope it reports, as the Choose Workspaces step holds it. */
function EditorWithOutput(props: {
  initialScope: Record<string, unknown>
  label?: string
}) {
  const [scope, setScope] = useState<Record<string, unknown> | null>(null)
  return (
    <>
      <BuildkiteScopeEditor
        orgSlug="acme"
        provider="buildkite"
        connectionId="con_buildkite1"
        initialScope={props.initialScope}
        label={props.label}
        onChange={setScope}
      />
      <output className="mt-4 block text-xs text-muted-foreground">
        {scope ? JSON.stringify(scope) : "Not ready"}
      </output>
    </>
  )
}

const pipelinesPath = ({ request }: { request: Request }) =>
  new URL(request.url).pathname.endsWith(
    "/api/v1/connectors/buildkite/pipelines",
  )

const meta = {
  title: "Components/WorkspaceSources/BuildkiteScopeEditor",
  component: EditorWithOutput,
  decorators: [
    (Story) => (
      <div className="max-w-lg bg-zinc-950 p-4">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: { handlers: { page: [buildkitePipelinesHandler] } },
  },
  args: { initialScope: {} },
} satisfies Meta<typeof EditorWithOutput>

export default meta

type Story = StoryObj<typeof meta>

export const SelectPipelines: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(await canvas.findByText("Not ready")).toBeVisible()
    await expect(
      canvas.getByText("Select at least one pipeline."),
    ).toBeVisible()
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: "Web App" }),
    )
    await userEvent.click(canvas.getByRole("checkbox", { name: "API" }))
    await expect(
      canvas.getByText(JSON.stringify({ pipelines: ["web-app", "api"] })),
    ).toBeVisible()
  },
}

export const FilterKeepsTheSelection: Story = {
  args: { label: "CI", initialScope: { pipelines: ["web-app"] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(
      await canvas.findByRole("checkbox", { name: "Web App" }),
    ).toBeChecked()
    await userEvent.type(
      canvas.getByRole("searchbox", {
        name: "Filter Buildkite pipelines for CI",
      }),
      "deploy",
    )
    await expect(
      canvas.queryByRole("checkbox", { name: "API" }),
    ).not.toBeInTheDocument()
    await userEvent.click(
      canvas.getByRole("checkbox", { name: "Deploy production" }),
    )
    // The filter hides "Web App", but a selected pipeline stays in the list.
    await expect(
      canvas.getByRole("checkbox", { name: "Web App" }),
    ).toBeChecked()
    await expect(
      canvas.getByText(
        JSON.stringify({ pipelines: ["web-app", "deploy-production"] }),
      ),
    ).toBeVisible()
  },
}

export const RemovedPipelineCanBeCleared: Story = {
  args: { initialScope: { pipelines: ["old-pipeline", "api"] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    // A selected slug that Buildkite no longer lists shows by its slug.
    const old = await canvas.findByRole("checkbox", { name: "old-pipeline" })
    await expect(old).toBeChecked()
    await userEvent.click(old)
    await expect(
      canvas.getByText(JSON.stringify({ pipelines: ["api"] })),
    ).toBeVisible()
  },
}

export const Loading: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(pipelinesPath, async () => {
            await delay("infinite")
            return HttpResponse.json({})
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(
      await canvas.findByText("Loading Buildkite pipelines"),
    ).toBeInTheDocument()
  },
}

export const LoadError: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(pipelinesPath, () =>
            HttpResponse.json(
              {
                error:
                  "Buildkite does not accept the API access token of this connection. Reconnect Buildkite.",
              },
              { status: 400 },
            ),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(await canvas.findByText(/Reconnect Buildkite/)).toBeVisible()
  },
}
