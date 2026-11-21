import preview from "../../../../.storybook/preview"
import { ConfluenceMark } from "./ConfluenceMark"

const meta = preview.meta({
  title: "Components/Connections/Atlassian/Mark",
  component: ConfluenceMark,
  parameters: { layout: "centered" },
  args: { className: "size-10 text-foreground" },
})

/**
 * Confluence mark, the outline logo in the ink color that names Confluence on
 * its connector card, setup dialog and Workspace sources: the mark alone,
 * enlarged.
 */
export const Mark = meta.story({
  parameters: {
    review: {
      kind: "component",
    },
  },
})
