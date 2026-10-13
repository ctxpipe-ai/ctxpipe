import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ComponentProps, useState } from "react"
import { expect, userEvent, within } from "storybook/test"
import {
  slackChannelsHandler,
  slackStoryChannels,
} from "@/mocks/slack-handlers"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { SlackScopeEditor } from "./slack"

/** The editor with the last scope it reported, as a form holds it. */
function EditorWithOutput(
  props: Omit<ComponentProps<typeof SlackScopeEditor>, "onChange">,
) {
  const [scope, setScope] = useState<Record<string, unknown> | null>(
    props.initialScope,
  )
  return (
    <>
      <SlackScopeEditor {...props} onChange={setScope} />
      <output
        aria-label="Scope"
        className="mt-4 block text-xs text-muted-foreground"
      >
        {JSON.stringify(scope)}
      </output>
    </>
  )
}

const meta = {
  title: "Components/WorkspaceSources/SlackScopeEditor",
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
    msw: { handlers: { page: [slackChannelsHandler()] } },
  },
  args: {
    orgSlug: "acme",
    provider: "slack",
    connectionId: "con_sl1",
    initialScope: {},
  },
} satisfies Meta<typeof EditorWithOutput>

export default meta

type Story = StoryObj<typeof meta>

const scopeText = (canvasElement: HTMLElement) =>
  within(canvasElement).getByRole("status", { name: "Scope" }).textContent

export const SearchesAndPicksChannels: Story = {
  play: async ({ canvasElement }) => {
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
    await expect(JSON.parse(scopeText(canvasElement) ?? "")).toEqual({
      channels: ["C0DES0001", "G0INC0001"],
    })
    await expect(canvas.getByText("2 channels selected.")).toBeVisible()
  },
}

/** A channel can be chosen before the bot is invited; it says to invite the bot. */
export const ChannelWithoutTheBotCanBeSelected: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const allHands = await canvas.findByRole("checkbox", { name: /all-hands/ })
    await expect(
      canvas.getByText(
        "Invite the bot to this channel before you mention it there.",
      ),
    ).toBeVisible()
    await userEvent.click(allHands)
    await expect(JSON.parse(scopeText(canvasElement) ?? "")).toEqual({
      channels: ["C0ALL0001"],
    })
  },
}

export const EditsAnExistingScope: Story = {
  args: { initialScope: { channels: ["C0ENG0001", "C0GONE001"] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      await canvas.findByRole("checkbox", { name: /^#eng$|eng$/ }),
    ).toBeChecked()
    const gone = canvas.getByRole("checkbox", { name: /C0GONE001/ })
    await expect(gone).toBeChecked()
    await userEvent.click(gone)
    await expect(JSON.parse(scopeText(canvasElement) ?? "")).toEqual({
      channels: ["C0ENG0001"],
    })
    await userEvent.click(canvas.getByRole("checkbox", { name: /^#eng$|eng$/ }))
    await expect(scopeText(canvasElement)).toBe("null")
    await expect(canvas.getByText("Select at least one channel.")).toBeVisible()
  },
}

export const LoadError: Story = {
  parameters: {
    msw: { handlers: { page: [slackChannelsHandler("error")] } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      await canvas.findByText("Could not load the Slack channels."),
    ).toBeVisible()
    await expect(canvas.getByRole("button", { name: "Retry" })).toBeVisible()
  },
}

/** Slack has more channels than the list holds, so the picker says so. */
export const ListIsTruncated: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [slackChannelsHandler(slackStoryChannels, { truncated: true })],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      await canvas.findByText(
        "Showing the first 2000 channels. Search finds channels in this list only.",
      ),
    ).toBeVisible()
  },
}
