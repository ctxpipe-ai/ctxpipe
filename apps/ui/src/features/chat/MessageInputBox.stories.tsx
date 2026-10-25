import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { Button } from "@/components/ui/Button"
import { workspaceSuggestions } from "@/features/workspaces/workspace-suggestions"

import { readChatDraft, writeChatDraft } from "./chat-draft"
import { MessageInputBox } from "./MessageInputBox"

const draftKey = "ctxpipe.chat-draft.story.ws_story.compose"

/** Remount the composer the way a route change does. */
function RemountHarness(props: Parameters<typeof MessageInputBox>[0]) {
  const [generation, setGeneration] = useState(0)
  return (
    <div className="flex w-full max-w-2xl flex-col gap-4">
      <MessageInputBox key={generation} {...props} />
      <Button
        variant="outline"
        className="self-start"
        onPress={() => setGeneration((value) => value + 1)}
      >
        Remount composer
      </Button>
    </div>
  )
}

const meta = {
  title: "Components/Chat/Message input",
  component: MessageInputBox,
  render: (args) => <RemountHarness {...args} />,
  parameters: {
    layout: "padded",
  },
  args: {
    layout: "empty",
    sendMessage: fn(),
    draftKey,
  },
} satisfies Meta<typeof MessageInputBox>

export default meta

type Story = StoryObj<typeof meta>

/** Typed text survives a remount under the same draft key, and a send clears it. */
export const DraftSurvivesRemount: Story = {
  beforeEach: () => {
    writeChatDraft(draftKey, "")
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(canvas.getByRole("textbox"), "What changed this week?")
    await waitFor(() => {
      expect(readChatDraft(draftKey)).toBe("What changed this week?")
    })
    await userEvent.click(
      canvas.getByRole("button", { name: "Remount composer" }),
    )
    expect(canvas.getByRole("textbox")).toHaveValue("What changed this week?")
    await userEvent.click(canvas.getByRole("button", { name: /send/i }))
    expect(args.sendMessage).toHaveBeenCalledWith({
      text: "What changed this week?",
    })
    await waitFor(() => {
      expect(readChatDraft(draftKey)).toBe("")
    })
    expect(canvas.getByRole("textbox")).toHaveValue("")
  },
}

/** Picking a suggested prompt fills the composer and focuses it. It does not send. */
export const SuggestionFillsComposer: Story = {
  beforeEach: () => {
    writeChatDraft(draftKey, "")
  },
  args: {
    suggestions: workspaceSuggestions,
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const trigger = canvas.getByRole("button", { name: "Suggested" })
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    await userEvent.click(trigger)
    await waitFor(() =>
      expect(trigger).toHaveAttribute("aria-expanded", "true"),
    )
    const suggestion = workspaceSuggestions[2]
    await userEvent.click(canvas.getByRole("button", { name: suggestion }))
    const composer = canvas.getByRole("textbox")
    expect(composer).toHaveValue(suggestion)
    expect(composer).toHaveFocus()
    expect(args.sendMessage).not.toHaveBeenCalled()
  },
}

/** No draft key: the composer starts empty every time. */
export const Thread: Story = {
  args: {
    layout: "thread",
    draftKey: undefined,
  },
}

/** While a turn streams the composer is locked, but Stop stays enabled and cancels the turn. */
export const StopDuringStreamedTurn: Story = {
  args: {
    layout: "thread",
    draftKey: undefined,
    status: "streaming",
    isDisabled: true,
    onStop: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    expect(canvas.getByRole("textbox")).toBeDisabled()
    const stop = canvas.getByRole("button", { name: "Stop" })
    expect(stop).toBeEnabled()
    await userEvent.click(stop)
    expect(args.onStop).toHaveBeenCalledTimes(1)
    expect(args.sendMessage).not.toHaveBeenCalled()
  },
}
