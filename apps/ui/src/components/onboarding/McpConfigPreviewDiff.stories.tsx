import type { Meta, StoryObj } from "@storybook/react-vite"
import { McpConfigPreviewDiff } from "@/components/onboarding/McpConfigPreviewDiff"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"

const meta = {
  title: "Components/Onboarding/Mcp/PreviewDiff",
  component: McpConfigPreviewDiff,
  decorators: [
    (Story) => (
      <div className="max-w-xl rounded-none border border-border bg-zinc-950 p-6">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof McpConfigPreviewDiff>

export default meta

type Story = StoryObj<typeof meta>

export const AdditionsAndRemovals: Story = {
  args: {
    before: `{
  "mcpServers": {
    "ctxpipe": { "url": "https://old.example/mcp" }
  }
}`,
    after: `{
  "mcpServers": {
    "ctxpipe": {
      "type": "streamable-http",
      "url": "https://app.ctxpipe.ai/mcp?orgSlug=acme"
    }
  }
}`,
  },
}

export const UnchangedOnly: Story = {
  args: {
    before: "same content",
    after: "same content",
  },
}
