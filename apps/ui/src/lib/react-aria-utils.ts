import { composeRenderProps } from "react-aria-components"
import { twMerge } from "tailwind-merge"

export {
  focusRing,
  focusVisibleClassName,
  focusVisibleRingClassName,
} from "./focus-styles"

export function composeTailwindRenderProps<T>(
  className: string | ((v: T) => string) | undefined,
  tw: string,
): string | ((v: T) => string) {
  return composeRenderProps(className, (className) => twMerge(tw, className))
}
