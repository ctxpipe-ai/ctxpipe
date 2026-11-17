import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"
import {
  slackChannelsHandler,
  slackStoryChannels,
} from "@/mocks/slack-handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { sourceDialogStoryFrame } from "../source-dialog-story-frame"
import { SlackScopeEditor } from "./slack"

const meta = {
  title: "Components/WorkspaceSources/SlackScopeEditor",
  component: SlackScopeEditor,
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
      handlers: { session: signedInHandlers, page: [slackChannelsHandler()] },
    },
  },
  args: {
    orgSlug: "acme",
    provider: "slack",
    connectionId: "con_sl1",
    initialScope: {},
    onChange: fn(),
  },
} satisfies Meta<typeof SlackScopeEditor>

export default meta

type Story = StoryObj<typeof meta>

export const SearchesAndPicksChannels: Story = {
  parameters: {
    review: {
      purpose:
        "Slack scope editor, where the user picks the channels of a Workspace source: the user searches the channels and picks two of them.",
    },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      await canvas.findByRole("searchbox", { name: "Search Slack channels" }),
      "#eng",
    )
    await expect(canvas.queryByRole("checkbox", { name: /all-hands/ })).toBe(
      null,
    )
    await userEvent.click(canvas.getByRole("checkbox", { name: /eng-design/ }))
    await userEvent.clear(canvas.getByRole("searchbox"))
    await userEvent.click(canvas.getByRole("checkbox", { name: /incidents/ }))
    await expect(args.onChange).toHaveBeenLastCalledWith({
      channels: ["C0DES0001", "G0INC0001"],
    })
    await expect(canvas.getByText("2 channels selected.")).toBeVisible()
  },
}

/** A channel can be chosen before the bot is invited; it says to invite the bot. */
export const ChannelWithoutTheBotCanBeSelected: Story = {
  parameters: {
    review: {
      purpose:
        "Slack scope editor in the Add source dialog: the user ticks #all-hands, a channel that the ctxpipe bot is not in yet, and the row tells the user to invite the bot there.",
    },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const allHands = await canvas.findByRole("checkbox", { name: /all-hands/ })
    await expect(
      canvas.getByText(
        "Invite the bot to this channel before you mention it there.",
      ),
    ).toBeVisible()
    await userEvent.click(allHands)
    await expect(args.onChange).toHaveBeenLastCalledWith({
      channels: ["C0ALL0001"],
    })
  },
}

export const EditsAnExistingScope: Story = {
  parameters: {
    review: {
      purpose:
        "Slack scope editor, where the user picks the channels of a Workspace source: a saved scope has a channel that Slack no longer lists, and the user clears all channels.",
    },
  },
  args: { initialScope: { channels: ["C0ENG0001", "C0GONE001"] } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByRole("checkbox", { name: /^#eng$|eng$/ }),
      ).toBeChecked(),
    )
    const gone = canvas.getByRole("checkbox", { name: /C0GONE001/ })
    await expect(gone).toBeChecked()
    await userEvent.click(gone)
    await expect(args.onChange).toHaveBeenLastCalledWith({
      channels: ["C0ENG0001"],
    })
    await userEvent.click(canvas.getByRole("checkbox", { name: /^#eng$|eng$/ }))
    await expect(args.onChange).toHaveBeenLastCalledWith(null)
    await expect(canvas.getByText("Select at least one channel.")).toBeVisible()
  },
}

export const LoadError: Story = {
  parameters: {
    review: {
      purpose:
        "Slack scope editor in the Add source dialog: the request for the Slack channels failed, so an error alert with Retry stands in place of the channel list.",
    },
    msw: { handlers: { page: [slackChannelsHandler("error")] } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByRole("alert")).toHaveTextContent(
        "Could not load the Slack channels.",
      ),
    )
    await expect(canvas.getByRole("button", { name: "Retry" })).toBeVisible()
  },
}

/** Slack has more channels than the list holds, so the picker says so. */
export const ListIsTruncated: Story = {
  parameters: {
    review: {
      purpose:
        "Slack scope editor, where the user picks the channels of a Workspace source: Slack has more channels than the list holds, so a note says that search finds only listed channels.",
    },
    msw: {
      handlers: {
        page: [slackChannelsHandler(slackStoryChannels, { truncated: true })],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByText(
          "Showing the first 2000 channels. Search finds channels in this list only.",
        ),
      ).toBeVisible(),
    )
  },
}
