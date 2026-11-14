/**
 * The deterministic layout checks of the screenshot capture
 * (scripts/ci/visual-capture.mjs). The capture calls `layoutProblems` in the
 * page of each story, after the screenshot of the end state. The browser
 * has the real layout, so these measurements are exact:
 *
 * - `overflow`: text that runs out of a box around it, or that a box clips
 *   with no ellipsis, and text of a dialog outside of the viewport.
 * - `axes`: the leading markers (icons, checkboxes, step markers) of the
 *   rows of one dialog or list that sit on almost the same vertical axis:
 *   their centers differ by more than 0.5 px and less than 8 px.
 * - `contrast`: text below WCAG AA contrast (the axe-core rule
 *   `color-contrast`).
 *
 * A story can accept a rule with a reason in `parameters.visual.allow`
 * (scripts/checks/visual.mjs). The fixture stories of
 * `layout-checks.stories.tsx` prove each rule.
 */
export type LayoutRule = "overflow" | "axes" | "contrast"

type LayoutProblem = {
  rule: LayoutRule
  /** The element: its tag, role or label, and the start of its text. */
  element: string
  /** What is wrong, with the measured numbers. */
  detail: string
}

/** The layout problems in `root`, without the rules of `skip`. */
export async function layoutProblems(
  root: Element,
  { skip = [] }: { skip?: readonly LayoutRule[] } = {},
): Promise<LayoutProblem[]> {
  return [
    ...(skip.includes("overflow") ? [] : overflowProblems(root)),
    ...(skip.includes("axes") ? [] : axisProblems(root)),
    ...(skip.includes("contrast") ? [] : await contrastProblems(root)),
  ]
}

const px = (value: number) => `${Number(value.toFixed(1))} px`

/** A short name of an element for a problem message. */
function describe(element: Element): string {
  const role = element.getAttribute("role")
  const slot = element.getAttribute("data-slot")
  const label = element.getAttribute("aria-label")
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim()
  return [
    element.tagName.toLowerCase(),
    role && `[role=${role}]`,
    slot && `[data-slot=${slot}]`,
    label && `[aria-label="${label.slice(0, 40)}"]`,
    text && ` "${text.length > 48 ? `${text.slice(0, 48)}…` : text}"`,
  ]
    .filter(Boolean)
    .join("")
}

/** Visible to a user: rendered, not transparent, and not visually hidden. */
function visible(element: Element): boolean {
  if (
    !element.checkVisibility({
      opacityProperty: true,
      visibilityProperty: true,
    })
  )
    return false
  const style = getComputedStyle(element)
  const box = element.getBoundingClientRect()
  // The `sr-only` pattern: a 1 px box that clips its content.
  return (
    !(box.width <= 1 && box.height <= 1) &&
    style.clip === "auto" &&
    style.clipPath === "none"
  )
}

const scrolls = (value: string) => value === "auto" || value === "scroll"

// A dialog: also a modal of `Modal` (components/ui/Modal.tsx) with no
// `Dialog` in it.
const dialogs = "dialog, [role=dialog], [role=alertdialog], [data-slot=modal]"

/**
 * Text that runs out of a box, or that a box clips with no ellipsis: for
 * each text, the innermost box around it that does not hold it. The walk to
 * the outer boxes ends at an ellipsis or a line clamp (truncated on
 * purpose), at a scroll container (the user can scroll to the text), and
 * at a positioned layer (a badge or a popover sits outside of its parent on
 * purpose). The text of a dialog must also be in the viewport.
 */
function overflowProblems(root: Element): LayoutProblem[] {
  const problems: LayoutProblem[] = []
  const named = new Set<Element>()
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement
    if (!parent || !node.textContent?.trim() || parent.closest("svg")) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    const rects = [...range.getClientRects()].filter(
      (rect) => rect.width && rect.height,
    )
    if (!rects.length || !visible(parent)) continue
    const text = {
      left: Math.min(...rects.map((rect) => rect.left)),
      right: Math.max(...rects.map((rect) => rect.right)),
      top: Math.min(...rects.map((rect) => rect.top)),
      bottom: Math.max(...rects.map((rect) => rect.bottom)),
    }
    // The line box of a font is taller than its glyphs: a small vertical
    // overflow (`leading-none`) shows no cut.
    const slack = Math.max(
      1,
      Number.parseFloat(getComputedStyle(parent).fontSize) / 4,
    )
    const found = boxAroundText(parent, text, slack)
    if (!found || named.has(found.box)) continue
    named.add(found.box)
    problems.push({
      rule: "overflow",
      element: describe(found.box),
      detail: found.detail,
    })
  }
  return problems
}

type Edges = { left: number; right: number; top: number; bottom: number }

/** The innermost box that does not hold the text, with the numbers. */
function boxAroundText(
  parent: Element,
  text: Edges,
  slack: number,
): { box: Element; detail: string } | undefined {
  for (
    let box: Element | null = parent;
    box && box !== document.body;
    box = box.parentElement
  ) {
    const style = getComputedStyle(box)
    if (style.display === "inline" || style.display === "contents") continue
    if (style.textOverflow === "ellipsis" || style.webkitLineClamp !== "none")
      return undefined
    const outer = box.getBoundingClientRect()
    const inner = {
      left: outer.left + box.clientLeft,
      top: outer.top + box.clientTop,
      right: outer.left + box.clientLeft + box.clientWidth,
      bottom: outer.top + box.clientTop + box.clientHeight,
    }
    const out = outside(text, inner, slack)
    const clips = style.overflowX !== "visible" || style.overflowY !== "visible"
    if (
      out &&
      !(out.horizontal ? scrolls(style.overflowX) : scrolls(style.overflowY))
    ) {
      // A box of 1 px (a visually hidden heading), and a clip that hides
      // all of the text (a collapsed panel), hide the text on purpose.
      const hidden =
        inner.right - inner.left <= 1 ||
        inner.bottom - inner.top <= 1 ||
        (clips &&
          (text.right <= inner.left ||
            text.left >= inner.right ||
            text.bottom <= inner.top ||
            text.top >= inner.bottom))
      if (hidden || !seen(box, text)) return undefined
      return {
        box,
        detail: `text ${clips ? "is clipped" : "runs"} ${px(out.by)} past the ${out.edge} edge of its ${px(out.horizontal ? inner.right - inner.left : inner.bottom - inner.top)} ${out.horizontal ? "wide" : "high"} box`,
      }
    }
    if (box.matches(dialogs)) {
      const view = outside(
        text,
        {
          left: 0,
          top: 0,
          right: window.innerWidth,
          bottom: window.innerHeight,
        },
        slack,
      )
      if (view)
        return {
          box,
          detail: `dialog text is ${px(view.by)} past the ${view.edge} edge of the viewport`,
        }
    }
    if (scrolls(style.overflowX) || scrolls(style.overflowY)) return undefined
    // A positioned layer (a badge, a popover) can sit outside of its
    // parent on purpose, but not outside of its dialog, alert or card.
    if (style.position === "absolute" || style.position === "fixed") {
      const surface = box.parentElement?.closest(
        `${dialogs}, [role=alert], [data-slot=card]`,
      )
      const past =
        surface && outside(text, surface.getBoundingClientRect(), slack)
      return past && seen(surface, text)
        ? {
            box: surface,
            detail: `text of a positioned layer runs ${px(past.by)} past the ${past.edge} edge of ${describe(surface).split(" ")[0]}`,
          }
        : undefined
    }
  }
  return undefined
}

/**
 * False when no part of the text can show: it is outside of a clipping box
 * around `box`, or beside the viewport (a pane that slides in).
 */
function seen(box: Element, text: Edges): boolean {
  if (text.right <= 0 || text.left >= window.innerWidth) return false
  for (
    let element = box.parentElement;
    element && element !== document.documentElement;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element)
    if (style.overflowX === "visible" && style.overflowY === "visible") continue
    const clip = element.getBoundingClientRect()
    if (
      text.right <= clip.left ||
      text.left >= clip.right ||
      text.bottom <= clip.top ||
      text.top >= clip.bottom
    )
      return false
  }
  return true
}

/** The edge of `box` that the text passes most, beyond the tolerance. */
function outside(text: Edges, box: Edges, slack: number) {
  const edges = [
    { edge: "left", by: box.left - text.left, horizontal: true },
    { edge: "right", by: text.right - box.right, horizontal: true },
    { edge: "top", by: box.top - text.top, horizontal: false },
    { edge: "bottom", by: text.bottom - box.bottom, horizontal: false },
  ].filter((item) => item.by > (item.horizontal ? 1 : slack))
  return edges.sort((a, b) => b.by - a.by)[0]
}

/** A small box at the start of a row: an icon, a checkbox, a step marker. */
type Marker = { element: Element; center: number }

function axisProblems(root: Element): LayoutProblem[] {
  const lists =
    "ul, ol, [role=list], [role=listbox], [role=grid], [role=menu], [role=tree]"
  // Each dialog is one scope; a list outside of a dialog is one too. A
  // scope in another scope belongs to the outer one.
  const scopes = [...root.querySelectorAll(`${dialogs}, ${lists}`)].filter(
    (scope) =>
      !scope.parentElement?.closest(dialogs) &&
      !scope.parentElement?.closest(lists),
  )
  const problems: LayoutProblem[] = []
  for (const scope of scopes) {
    if (!visible(scope)) continue
    // Markers in one panel: a box with its own border or fill around two or
    // more markers (a bordered list, a card) has its own axes. A box around
    // one marker is a row of its column (a filled row, a selected item).
    const markers = leadingMarkers(scope)
    const panels = new Map<Element, Marker[]>()
    for (const marker of markers) {
      let panel = marker.element.parentElement ?? scope
      for (; panel !== scope; panel = panel.parentElement ?? scope) {
        const style = getComputedStyle(panel)
        const boxed =
          Number.parseFloat(style.borderLeftWidth) > 0 ||
          !["rgba(0, 0, 0, 0)", "transparent"].includes(style.backgroundColor)
        const holds = markers.filter((other) =>
          panel.contains(other.element),
        ).length
        if (boxed && holds > 1) break
      }
      panels.set(panel, [...(panels.get(panel) ?? []), marker])
    }
    for (const markers of panels.values()) {
      markers.sort((a, b) => a.center - b.center)
      // One axis: markers whose centers are less than 8 px apart.
      const columns: Marker[][] = []
      for (const marker of markers) {
        const column = columns.at(-1)
        if (column && marker.center - (column.at(-1)?.center ?? 0) < 8)
          column.push(marker)
        else columns.push([marker])
      }
      for (const column of columns) {
        const centers = [
          ...new Set(column.map((marker) => Number(marker.center.toFixed(1)))),
        ]
        const spread = Math.max(...centers) - Math.min(...centers)
        if (spread <= 0.5) continue
        problems.push({
          rule: "axes",
          element: describe(scope),
          detail: `${column.length} leading markers sit on ${centers.length} near axes (center x ${centers.join(", ")}): the centers differ by ${px(spread)}. First: ${describe(column[0].element)}`,
        })
      }
    }
  }
  return problems
}

/**
 * The leading markers of the rows of `scope`: the first visible child of an
 * element, when it is a small box (6 to 40 px, with no text or a step
 * number), with more content to its right and no text to its left on its
 * line. A table cell, and an icon before a text field, are not markers.
 */
function leadingMarkers(scope: Element): Marker[] {
  const lines: DOMRect[] = []
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    lines.push(...range.getClientRects())
  }
  const markers: Marker[] = []
  for (const row of scope.querySelectorAll("*")) {
    if (row instanceof SVGElement) continue
    const nodes = [...row.childNodes].filter((node) =>
      node.nodeType === Node.TEXT_NODE
        ? Boolean(node.textContent?.trim())
        : node instanceof Element && visible(node),
    )
    const [first, next] = nodes
    if (!(first instanceof Element) || !next) continue
    const box = first.getBoundingClientRect()
    if (
      box.width < 6 ||
      box.width > 40 ||
      box.height < 6 ||
      box.height > 40 ||
      !/^\d{0,2}$/.test((first.textContent ?? "").trim()) ||
      first.matches("td, th, [role=gridcell], [role=columnheader]")
    )
      continue
    // An icon in a field (a search icon) belongs to the field, not to a
    // column of rows.
    if (
      next instanceof Element &&
      next.matches("input, textarea, select, [role=textbox], [role=searchbox]")
    )
      continue
    const range = document.createRange()
    range.selectNode(next)
    if (range.getBoundingClientRect().left < box.right - 1) continue
    const textBefore = lines.some(
      (line) =>
        line.width > 0 &&
        line.right <= box.left + 1 &&
        line.top < box.bottom &&
        line.bottom > box.top,
    )
    if (textBefore) continue
    markers.push({ element: first, center: box.left + box.width / 2 })
  }
  // A marker in a marker (an icon in its tile) is one marker: the outer one.
  return markers.filter(
    (marker) =>
      !markers.some(
        (other) => other !== marker && other.element.contains(marker.element),
      ),
  )
}

async function contrastProblems(root: Element): Promise<LayoutProblem[]> {
  // Loaded on the first check, so that axe-core does not slow the start of
  // each story (a graph story renders by time).
  const { default: axe } = await import("axe-core")
  const options = {
    runOnly: { type: "rule" as const, values: ["color-contrast"] },
    resultTypes: ["violations" as const],
  }
  // The a11y addon of Storybook can still run axe after the story renders:
  // wait for it, at most 5 times 500 ms.
  let results
  for (let attempt = 1; !results; attempt++)
    results = await axe.run(root, options).catch(async (error: unknown) => {
      if (attempt === 5 || !String(error).includes("already running"))
        throw error
      await new Promise((resolve) => setTimeout(resolve, 500))
      return undefined
    })
  return results.violations.flatMap((violation) =>
    violation.nodes.map((node) => {
      const data: Record<string, unknown> = node.any[0]?.data ?? {}
      const text = (key: string) =>
        typeof data[key] === "string" || typeof data[key] === "number"
          ? String(data[key])
          : "?"
      const selector = node.target[0]
      const element =
        typeof selector === "string" ? document.querySelector(selector) : null
      return {
        rule: "contrast" as const,
        element: element ? describe(element) : String(node.target),
        detail: `contrast ${text("contrastRatio")}:1 is below ${text("expectedContrastRatio")} (${text("fgColor")} on ${text("bgColor")}, ${text("fontSize")})`,
      }
    }),
  )
}
