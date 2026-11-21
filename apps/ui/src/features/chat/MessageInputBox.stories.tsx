import { useState } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { Button } from "@/components/ui/Button"
import { workspaceSuggestions } from "@/features/workspaces/workspace-suggestions"

import preview from "../../../.storybook/preview"
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

const meta = preview.meta({
  title: "Components/Chat/Message input",
  component: MessageInputBox,
  render: (args) => <RemountHarness {...args} />,
  parameters: {
    review: { kind: "component" },
    layout: "padded",
  },
  args: {
    layout: "empty",
    sendMessage: fn(),
    draftKey,
  },
})

/**
 * Chat message composer with a saved draft: the user types text, and the text
 * stays after a remount under the same draft key. The send then clears the
 * draft, so the composer is empty again.
 */
export const DraftSurvivesRemount = meta.story({
  parameters: {
    visual: {
      skip: "Behavior test: it ends on a test harness with a Remount composer button, which the product does not render.",
    },
  },
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
})

/**
 * Chat message composer with suggested prompts: the user opened the list and
 * picked one. The prompt fills the composer and the composer gets focus, but
 * nothing is sent.
 */
export const SuggestionFillsComposer = meta.story({
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
})

/**
 * Chat message composer under a conversation thread: it has no draft key and no
 * saved draft, so it starts empty every time.
 */
export const Thread = meta.story({
  args: {
    layout: "thread",
    draftKey: undefined,
  },
})

/**
 * Chat message composer under a thread while a reply streams: the text box is
 * locked, and the Stop button stays active. A click on Stop cancels the turn.
 */
export const StopDuringStreamedTurn = meta.story({
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
})
