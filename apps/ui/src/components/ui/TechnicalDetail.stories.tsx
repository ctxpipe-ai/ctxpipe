import { expect, within } from "storybook/test"

import preview from "../../../.storybook/preview"
import { InlineAlert } from "./InlineAlert"
import { TechnicalDetail } from "./TechnicalDetail"

const meta = preview.meta({
  title: "Components/TechnicalDetail",
  component: TechnicalDetail,
  parameters: {
    layout: "centered",
    review: { kind: "component" },
  },
})

/**
 * Raw server reason in an error alert after a Workspace failed to load: the
 * clone URL in the reason holds a GitHub token, and the block hides the token.
 */
export const ReasonWithToken = meta.story({
  args: {
    tone: "error",
    children:
      "clone failed: https://x-access-token:ghs_0123456789abcdefghijklmnopqrstuvwxyz@github.com/acme/handbook.git returned 403",
  },
  render: (args) => (
    <div className="w-md">
      <InlineAlert variant="error" title="Could not load the Workspace">
        <p>The server refused the request (status 403).</p>
        <TechnicalDetail {...args} className="mt-2" />
      </InlineAlert>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const detail = within(canvasElement).getByText(/clone failed/)
    await expect(detail).not.toHaveTextContent("ghs_0123456789")
    await expect(detail).toHaveTextContent("returned 403")
  },
})
