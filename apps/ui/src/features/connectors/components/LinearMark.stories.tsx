import preview from "../../../../.storybook/preview"
import { LinearMark } from "./LinearMark"

const meta = preview.meta({
  title: "Components/Connections/Linear/Mark",
  component: LinearMark,
  parameters: { layout: "centered" },
  args: { className: "size-10 text-foreground" },
})

/**
 * Linear logo mark that labels the Linear connector: the mark alone at icon
 * size.
 */
export const ProductMark = meta.story({
  parameters: {
    review: {
      kind: "component",
    },
  },
})
