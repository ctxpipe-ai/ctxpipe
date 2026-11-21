import preview from "../../../../.storybook/preview"
import { PlainMark } from "./PlainMark"

const meta = preview.meta({
  title: "Components/Connections/Plain/Mark",
  component: PlainMark,
  parameters: { layout: "centered", review: { kind: "component" } },
  args: { className: "size-10 text-foreground" },
})

/**
 * Plain mark, the logo in the ink color that names Plain on its connector card
 * and setup dialog: the mark alone, enlarged.
 */
export const ProductMark = meta.story()
