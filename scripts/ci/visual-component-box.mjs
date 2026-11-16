// The area of the screenshot of a component story
// (`parameters.review.kind: "component"`, scripts/ci/visual-capture.mjs).
// A page story shows the full page (visual-full-page.mjs). A component story
// shows only the component, as Chromatic crops a snapshot to the size of the
// rendered UI.
//
// The area is the union of the boxes of what the story paints, with a
// padding of 16 px, in the full page at the width of the viewport:
// - The story: the content of the decorator of preview.tsx (the first child
//   of `#storybook-root`). That decorator is as high as the viewport
//   (`min-h-screen`), so the capture looks into it.
// - The overlays: each element outside `#storybook-root` in the body (the
//   portal of a dialog, a popover, a menu or a toast). The dim underlay of a
//   modal paints the viewport, so a story with an open modal shows the full
//   page. The underlay of a popover is transparent, so it adds nothing.
// An element paints its box when it has a background, a border or a shadow,
// and when it is an image, a canvas, an SVG or a form control. A background
// of the same color as the decorator does not count: a wrapper with
// `min-h-screen bg-background` shows nothing. A text paints the box of its
// characters. The walk does not count what is hidden: an element with
// `display: none`, `opacity: 0` or `visibility: hidden`, a box of 1 px or
// less (a visually hidden label), and the part of a box outside an ancestor
// that clips its content (`overflow` is not `visible`; a fixed element
// escapes the clip). When the story paints nothing, the screenshot shows the
// full page.

// The padding around the component, in pixels.
export const padding = 16

// Runs in the page. Returns the box of each part that the story and its
// overlays paint, in page coordinates (`{ x, y, width, height }`).
export function storyBoxes() {
  const root = document.getElementById("storybook-root")
  const decorator = root?.firstElementChild
  const backdrop = decorator
    ? getComputedStyle(decorator).backgroundColor
    : "rgba(0, 0, 0, 0)"
  const transparent = (color) => /^rgba\(.*, 0\)$|^transparent$/.test(color)
  const replaced = /^(IMG|SVG|CANVAS|VIDEO|INPUT|TEXTAREA|SELECT|IFRAME|PROGRESS|METER)$/i
  const boxes = []
  // Adds the part of `box` (a DOMRect) inside `clip` (null: no clip).
  const add = (box, clip) => {
    const left = Math.max(box.left, clip?.left ?? -Infinity)
    const top = Math.max(box.top, clip?.top ?? -Infinity)
    const right = Math.min(box.right, clip?.right ?? Infinity)
    const bottom = Math.min(box.bottom, clip?.bottom ?? Infinity)
    if (right - left > 1 && bottom - top > 1)
      boxes.push({
        x: left + window.scrollX,
        y: top + window.scrollY,
        width: right - left,
        height: bottom - top,
      })
  }
  const paints = (element, style) =>
    replaced.test(element.tagName) ||
    (!transparent(style.backgroundColor) &&
      style.backgroundColor !== backdrop) ||
    style.backgroundImage !== "none" ||
    style.boxShadow !== "none" ||
    ["Top", "Right", "Bottom", "Left"].some(
      (side) =>
        parseFloat(style[`border${side}Width`]) > 0 &&
        style[`border${side}Style`] !== "none" &&
        !transparent(style[`border${side}Color`]),
    )
  const visit = (element, outerClip) => {
    const style = getComputedStyle(element)
    if (style.display === "none" || style.opacity === "0") return
    const clip = style.position === "fixed" ? null : outerClip
    const box = element.getBoundingClientRect()
    const visible = style.visibility === "visible"
    if (visible && paints(element, style)) add(box, clip)
    if (replaced.test(element.tagName)) return
    for (const node of element.childNodes)
      if (visible && node.nodeType === Node.TEXT_NODE && node.data.trim()) {
        const range = document.createRange()
        range.selectNodeContents(node)
        add(range.getBoundingClientRect(), clip)
      }
    const inner =
      style.overflowX === "visible" && style.overflowY === "visible"
        ? clip
        : {
            left: Math.max(box.left, clip?.left ?? -Infinity),
            top: Math.max(box.top, clip?.top ?? -Infinity),
            right: Math.min(box.right, clip?.right ?? Infinity),
            bottom: Math.min(box.bottom, clip?.bottom ?? Infinity),
          }
    for (const child of element.children) visit(child, inner)
  }
  for (const child of decorator?.children ?? []) visit(child, null)
  for (const child of document.body.children)
    if (child !== root) visit(child, null)
  return boxes
}

// The clip of the screenshot (Playwright's `clip` with `fullPage`): the union
// of `boxes` with the padding, inside the page (`{ width, height }`), in whole
// pixels. Null when there is no box.
export function componentClip(boxes, page) {
  if (!boxes.length) return null
  const left = Math.min(...boxes.map((box) => box.x)) - padding
  const top = Math.min(...boxes.map((box) => box.y)) - padding
  const right = Math.max(...boxes.map((box) => box.x + box.width)) + padding
  const bottom = Math.max(...boxes.map((box) => box.y + box.height)) + padding
  const x = Math.max(0, Math.floor(left))
  const y = Math.max(0, Math.floor(top))
  const width = Math.min(page.width, Math.ceil(right)) - x
  const height = Math.min(page.height, Math.ceil(bottom)) - y
  return width > 0 && height > 0 ? { x, y, width, height } : null
}
