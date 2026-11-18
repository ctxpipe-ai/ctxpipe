import type { Meta, StoryObj } from "@storybook/react-vite"
import { BUILDKITE_SOURCE_MAX_PIPELINES } from "backend/domain/workspace-sources/providers/buildkite"
import { delay, HttpResponse, http } from "msw"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { buildkitePipelinesHandler } from "@/mocks/buildkite-handlers"
import { signedInHandlers } from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { sourceDialogStoryFrame } from "../source-dialog-story-frame"
import { BuildkiteScopeEditor } from "./buildkite"

const pipelinesPath = ({ request }: { request: Request }) =>
  new URL(request.url).pathname.endsWith(
    "/api/v1/connectors/buildkite/pipelines",
  )

const meta = {
  title: "Components/WorkspaceSources/BuildkiteScopeEditor",
  component: BuildkiteScopeEditor,
  decorators: [sourceDialogStoryFrame],
  parameters: {
    app: "root",
    review: { kind: "component" },
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        session: signedInHandlers,
        page: [buildkitePipelinesHandler],
      },
    },
  },
  args: {
    orgSlug: "acme",
    provider: "buildkite",
    connectionId: "con_buildkite1",
    initialScope: {},
    onChange: fn(),
  },
} satisfies Meta<typeof BuildkiteScopeEditor>

export default meta

type Story = StoryObj<typeof meta>

/**
 * Buildkite scope editor in the Add source dialog, where the user picks the
 * pipelines that a Workspace source syncs: from an empty selection, the user
 * ticks Web App and API.
 */
export const SelectPipelines: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(canvas.getByText("Select at least one pipeline.")).toBeVisible(),
    )
    await expect(args.onChange).not.toHaveBeenCalled()
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: "Web App" }),
    )
    await userEvent.click(canvas.getByRole("checkbox", { name: "API" }))
    await expect(args.onChange).toHaveBeenLastCalledWith({
      pipelines: ["web-app", "api"],
    })
  },
}

/**
 * Buildkite scope editor in the Add source dialog: Web App is selected, the
 * user filters for deploy and ticks Deploy production, and Web App stays in the
 * list as selected.
 */
export const FilterKeepsTheSelection: Story = {
  args: { label: "CI", initialScope: { pipelines: ["web-app"] } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(canvas.getByRole("checkbox", { name: "Web App" })).toBeChecked(),
    )
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
    await expect(args.onChange).toHaveBeenLastCalledWith({
      pipelines: ["web-app", "deploy-production"],
    })
  },
}

/**
 * Buildkite scope editor in the Edit source dialog: the saved scope has a
 * pipeline that Buildkite no longer lists, which shows by its slug, and the
 * user clears it.
 */
export const RemovedPipelineCanBeCleared: Story = {
  args: { initialScope: { pipelines: ["old-pipeline", "api"] } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    // A selected slug that Buildkite no longer lists shows by its slug.
    const old = await canvas.findByRole("checkbox", { name: "old-pipeline" })
    await expect(old).toBeChecked()
    await userEvent.click(old)
    await expect(args.onChange).toHaveBeenLastCalledWith({
      pipelines: ["api"],
    })
  },
}

// One more pipeline than a source can hold. Each service has a build and
// two deploy pipelines, as in a real Buildkite organization.
const manyPipelines = [
  "Admin console",
  "Analytics",
  "API",
  "Auth",
  "Billing",
  "Docs site",
  "Exports",
  "Gateway",
  "Imports",
  "Mobile",
  "Notifications",
  "Payments",
  "Scheduler",
  "Search",
  "Web App",
  "Webhooks",
  "Worker",
].flatMap((service) =>
  ["build", "deploy staging", "deploy production"].map((pipeline) => {
    const name = `${service} ${pipeline}`
    return { slug: name.toLowerCase().replaceAll(" ", "-"), name }
  }),
)

/**
 * Buildkite scope editor in the Add source dialog: 50 pipelines are selected,
 * the user ticks one more, so an error states the 50-pipeline limit and the
 * dialog cannot save.
 */
export const OverThePipelineLimit: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(pipelinesPath, () =>
            HttpResponse.json({ items: manyPipelines, truncated: false }),
          ),
        ],
      },
    },
  },
  args: {
    // A full selection: all pipelines but the first.
    initialScope: {
      pipelines: manyPipelines.slice(1).map((pipeline) => pipeline.slug),
    },
  },
  play: async ({ args, canvasElement }) => {
    await expect(manyPipelines).toHaveLength(BUILDKITE_SOURCE_MAX_PIPELINES + 1)
    const canvas = within(canvasElement.ownerDocument.body)
    const limit = `Select at most ${BUILDKITE_SOURCE_MAX_PIPELINES} Buildkite pipelines.`
    const first = await canvas.findByRole("checkbox", {
      name: manyPipelines[0]?.name,
    })
    await expect(canvas.queryByText(limit)).not.toBeInTheDocument()
    await userEvent.click(first)
    await waitFor(() => expect(canvas.getByText(limit)).toBeVisible())
    // Above the cap, the scope is not ready, so the dialog cannot save.
    await expect(args.onChange).toHaveBeenLastCalledWith(null)
  },
}

/**
 * Buildkite scope editor, where the user picks the pipelines of a Workspace
 * source: the pipeline list still loads.
 */
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
    await waitFor(() =>
      expect(
        canvas.getByText("Loading Buildkite pipelines"),
      ).toBeInTheDocument(),
    )
  },
}

/**
 * Buildkite scope editor, where the user picks the pipelines of a Workspace
 * source: Buildkite refuses the access token, so an error asks the user to
 * reconnect Buildkite.
 */
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
    await waitFor(() =>
      expect(canvas.getByText(/Reconnect Buildkite/)).toBeVisible(),
    )
  },
}
