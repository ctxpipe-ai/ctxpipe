import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { Button } from "@/components/ui/Button"
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

/** No draft key: the composer starts empty every time. */
export const Thread: Story = {
  args: {
    layout: "thread",
    draftKey: undefined,
  },
}
