// The synthetic changes of the bake-off. Each one is a CSS change on one
// element of a rendered story, in the browser, before the screenshot. The
// source of the story does not change. `collectFacts` and `applyMutation` run
// in the page; `planMutation` and `knownRegion` run in Node and are pure.

import type { PixelBox } from "../../src/compare/diff.ts"

/** The regression classes of the plan (CTX-1178, Phase 4). */
export const regressionClasses = [
  "padding",
  "color-token",
  "overflow",
  "truncated-text",
  "contrast-loss",
  "missing-element",
  "dark-surface",
  "focus-ring",
] as const

/** Changes that a person does not see: the critic must call them noise. */
export const noiseClasses = ["subpixel-shift", "antialiasing"] as const

export type RegressionClass = (typeof regressionClasses)[number]
export type NoiseClass = (typeof noiseClasses)[number]
export type MutationClass = RegressionClass | NoiseClass

export type Rgb = [number, number, number]

/** What `planMutation` must know about one element of the page. */
export type ElementFacts = {
  /** In CSS pixels of the viewport. */
  box: PixelBox
  tag: string
  /** The element has a text node of its own. */
  text: boolean
  /** The width of the text in the element, in pixels. */
  textWidth: number
  /** Its `display` is `inline`, so a width does not apply to it. */
  inline: boolean
  /** The sum of its four paddings, in pixels. */
  padding: number
  /** Its own background color; null when the background is transparent. */
  background: Rgb | null
  /** The color behind the element: its first ancestor background. */
  surface: Rgb
  /** Its text color. */
  color: Rgb
  /** A button, a link, a form control or an element with a tab index. */
  focusable: boolean
  /**
   * A keyboard focus gives it an outline or a shadow. `collectFacts` probes
   * this only when it is asked to, because a focus can change the page.
   */
  focusRing: boolean
  /** An `svg` or an `img`. */
  graphic: boolean
}

/** The facts of a page. Element 0 is the story root. */
export type PageFacts = {
  viewport: { width: number; height: number }
  elements: ElementFacts[]
  /** Color tokens of the theme, as the page resolves them. */
  tokens: { name: string; rgb: Rgb }[]
  /** The custom properties of the light theme (the `:root` rule). */
  lightTokens: Record<string, string>
}

type MutationPlan = {
  kind: MutationClass
  /** The index of the element in `PageFacts.elements`. */
  target: number
  /** Focus the target before the clean screenshot. */
  focus: boolean
  /** Repeat the text of the target this many times; 0 keeps the text. */
  repeatText: number
  /** CSS properties to set on the target, each with `!important`. */
  style: Record<string, string>
}

/** A seeded random function (mulberry32): the same seed gives the same values. */
export function seeded(seed: number): () => number {
  let state = seed | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const distance = (a: Rgb, b: Rgb) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

// Relative luminance (0 black, 1 white), from WCAG 2.
const luminance = ([r, g, b]: Rgb) => {
  const linear = (channel: number) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

// What each regression class needs of its target, and the CSS change.
const classes: Record<
  RegressionClass,
  {
    fits: (element: ElementFacts, page: PageFacts) => boolean
    style: (
      element: ElementFacts,
      page: PageFacts,
      random: () => number,
    ) => Record<string, string>
    focus?: true
    repeatText?: number
  }
> = {
  padding: {
    fits: (element) => element.padding >= 4,
    style: () => ({ padding: "0px" }),
  },
  "color-token": {
    fits: (element, page) => farTokens(element, page).length > 0,
    style: (element, page, random) => {
      const far = farTokens(element, page)
      return {
        "background-color": `var(${far[Math.floor(random() * far.length)]!.name})`,
      }
    },
  },
  // Longer text that does not wrap, in a box as wide as the old text: the
  // text runs out of the box, over its neighbors.
  overflow: {
    fits: (element) => element.text && element.textWidth >= 40,
    style: (element) => ({
      ...(element.inline ? { display: "inline-block" } : {}),
      width: `${element.textWidth}px`,
      "white-space": "nowrap",
      overflow: "visible",
    }),
    repeatText: 5,
  },
  "truncated-text": {
    fits: (element) => element.text && element.textWidth >= 40,
    style: (element) => ({
      ...(element.inline ? { display: "inline-block" } : {}),
      "max-width": `${Math.round(element.textWidth / 2)}px`,
      overflow: "hidden",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    }),
  },
  "contrast-loss": {
    fits: (element) =>
      element.text && distance(element.color, element.surface) > 100,
    style: (element) => {
      const mix = element.surface.map((channel, i) =>
        Math.round(channel * 0.8 + element.color[i]! * 0.2),
      )
      return { color: `rgb(${mix.join(", ")})` }
    },
  },
  "missing-element": {
    fits: (element) => element.graphic || element.tag === "button",
    style: () => ({ visibility: "hidden" }),
  },
  "dark-surface": {
    fits: (element, page) =>
      element.background !== null &&
      luminance(element.background) < 0.05 &&
      element.box.width * element.box.height >= 4000 &&
      Object.keys(page.lightTokens).length > 0,
    style: (_, page) => ({
      ...page.lightTokens,
      "color-scheme": "light",
      "background-color": "var(--card)",
      color: "var(--card-foreground)",
    }),
  },
  "focus-ring": {
    fits: (element) => element.focusRing,
    style: () => ({ outline: "none", "box-shadow": "none" }),
    focus: true,
  },
}

// Tokens whose color is clearly not the background of the element.
function farTokens(element: ElementFacts, page: PageFacts) {
  const background = element.background
  return background
    ? page.tokens.filter((token) => distance(token.rgb, background) > 60)
    : []
}

const noise: Record<NoiseClass, Record<string, string>> = {
  // Measured in the capture container: a transform below one pixel, and a
  // thin text stroke, change from about 20 to 3000 pixels of a story.
  "subpixel-shift": { transform: "translate(0.5px, 0)" },
  antialiasing: { "-webkit-text-stroke": "0.2px currentColor" },
}

const onScreen = (box: PixelBox, viewport: PageFacts["viewport"]) =>
  box.width >= 4 &&
  box.height >= 4 &&
  box.x >= 0 &&
  box.y >= 0 &&
  box.x + box.width <= viewport.width &&
  box.y + box.height <= viewport.height

/**
 * Picks the target of one class on a page, and the CSS change. Returns null
 * when no element of the page can show the class. A noise class changes the
 * whole story (element 0).
 */
export function planMutation(
  kind: MutationClass,
  page: PageFacts,
  random: () => number,
): MutationPlan | null {
  if (kind === "subpixel-shift" || kind === "antialiasing")
    return { kind, target: 0, focus: false, repeatText: 0, style: noise[kind] }
  const rule = classes[kind]
  const fitting = page.elements.flatMap((element, index) =>
    index > 0 &&
    onScreen(element.box, page.viewport) &&
    rule.fits(element, page)
      ? [index]
      : [],
  )
  if (!fitting.length) return null
  const target = fitting[Math.floor(random() * fitting.length)]!
  return {
    kind,
    target,
    focus: rule.focus ?? false,
    repeatText: rule.repeatText ?? 0,
    style: rule.style(page.elements[target]!, page, random),
  }
}

/**
 * The known region of a synthetic change: the union of the boxes of its
 * target (before and after the change), 2 pixels wider on each side, in whole
 * pixels on the screen. Null when no part is on the screen.
 */
export function knownRegion(
  boxes: readonly PixelBox[],
  viewport: PageFacts["viewport"],
): PixelBox | null {
  const margin = 2
  const left = Math.max(
    0,
    Math.floor(Math.min(...boxes.map((b) => b.x)) - margin),
  )
  const top = Math.max(
    0,
    Math.floor(Math.min(...boxes.map((b) => b.y)) - margin),
  )
  const right = Math.min(
    viewport.width,
    Math.ceil(Math.max(...boxes.map((b) => b.x + b.width)) + margin),
  )
  const bottom = Math.min(
    viewport.height,
    Math.ceil(Math.max(...boxes.map((b) => b.y + b.height)) + margin),
  )
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * Runs in the page (Playwright `page.evaluate`). Lists the visible elements of
 * the story, from the story root, and marks each one with
 * `data-bakeoff-index`. It must not use a name from outside the function.
 */
export function collectFacts(probeFocus: boolean): PageFacts {
  const canvas = document.createElement("canvas")
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext("2d", { willReadFrequently: true })!
  // The canvas reads any CSS color (oklch, color-mix) as sRGB. The result
  // for a transparent color is null.
  const rgb = (css: string): [number, number, number] | null => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = "#000"
    context.fillStyle = css
    context.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
    return a! < 128 ? null : [r!, g!, b!]
  }
  const root =
    document.querySelector<HTMLElement>("#storybook-root > *") ?? document.body
  const viewport = { width: innerWidth, height: innerHeight }
  const surfaceOf = (element: Element): [number, number, number] => {
    for (let node = element.parentElement; node; node = node.parentElement) {
      const color = rgb(getComputedStyle(node).backgroundColor)
      if (color) return color
    }
    return [0, 0, 0]
  }
  const textWidth = (element: Element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    return Math.round(range.getBoundingClientRect().width)
  }
  // A keyboard focus shows a ring when it sets an outline or a shadow.
  const ringed = (element: HTMLElement) => {
    const ring = () => {
      const style = getComputedStyle(element)
      return `${style.outlineStyle} ${style.outlineWidth} ${style.boxShadow}`
    }
    const rest = ring()
    element.focus({ focusVisible: true, preventScroll: true } as FocusOptions)
    const focused = document.activeElement === element ? ring() : rest
    element.blur()
    return focused !== rest
  }
  const visible = (element: Element) => {
    const style = getComputedStyle(element)
    return (
      style.display !== "none" &&
      style.visibility === "visible" &&
      Number(style.opacity) > 0
    )
  }
  // The story root first, then each visible element of the page (a popover
  // can render outside the root).
  const all = [
    root,
    ...Array.from(document.body.querySelectorAll("*")).filter(
      (element) =>
        element !== root &&
        !["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT"].includes(
          element.tagName,
        ) &&
        !element.closest("#storybook-docs") &&
        element.getClientRects().length > 0 &&
        visible(element),
    ),
  ].slice(0, 4000)
  const elements = all.map((element, index) => {
    element.setAttribute("data-bakeoff-index", String(index))
    const style = getComputedStyle(element)
    const box = element.getBoundingClientRect()
    const tag = element.tagName.toLowerCase()
    const focusable =
      ["button", "a", "input", "select", "textarea"].includes(tag) ||
      element.hasAttribute("tabindex")
    return {
      box: {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      },
      tag,
      text: Array.from(element.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim(),
      ),
      textWidth: textWidth(element),
      inline: style.display === "inline",
      padding:
        parseFloat(style.paddingTop) +
        parseFloat(style.paddingRight) +
        parseFloat(style.paddingBottom) +
        parseFloat(style.paddingLeft),
      background: rgb(style.backgroundColor),
      surface: surfaceOf(element),
      color: rgb(style.color) ?? [0, 0, 0],
      focusable,
      focusRing: probeFocus && focusable && ringed(element as HTMLElement),
      graphic: tag === "svg" || tag === "img",
    }
  })
  // The semantic color tokens of apps/ui/src/styles.css, resolved on a probe.
  const probe = document.createElement("div")
  root.append(probe)
  const tokens = [
    "--primary",
    "--secondary",
    "--muted",
    "--accent",
    "--destructive",
    "--cta",
    "--border",
    "--chart-1",
    "--chart-2",
    "--chart-3",
    "--chart-4",
    "--chart-5",
  ].flatMap((name) => {
    probe.style.backgroundColor = `var(${name})`
    const color = rgb(getComputedStyle(probe).backgroundColor)
    return color ? [{ name, rgb: color }] : []
  })
  probe.remove()
  // The light theme is the `:root` rule that sets `--background`.
  const lightTokens: Record<string, string> = {}
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (
        rule instanceof CSSStyleRule &&
        rule.selectorText === ":root" &&
        rule.style.getPropertyValue("--background")
      ) {
        for (const name of Array.from(rule.style))
          if (name.startsWith("--") && !name.startsWith("--font"))
            lightTokens[name] = rule.style.getPropertyValue(name).trim()
      } else if ("cssRules" in rule) visit(rule.cssRules as CSSRuleList)
    }
  }
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules)
    } catch {
      // A style sheet of another origin cannot be read.
    }
  }
  return { viewport, elements, tokens, lightTokens }
}

/**
 * Runs in the page. Focuses the target of a plan, so that its focus ring
 * shows. A programmatic focus shows the ring only with `focusVisible`.
 */
export function focusTarget(target: number): void {
  document
    .querySelector<HTMLElement>(`[data-bakeoff-index="${target}"]`)
    ?.focus({ focusVisible: true } as FocusOptions)
}

/**
 * Runs in the page. Sets the style of a plan on its target, and returns the
 * boxes that the change touched: the target, and the text in it (an overflow
 * goes out of the box).
 */
export function applyMutation({
  target,
  style,
  repeatText,
}: Pick<MutationPlan, "target" | "style" | "repeatText">): PixelBox[] {
  const element = document.querySelector<HTMLElement>(
    `[data-bakeoff-index="${target}"]`,
  )
  if (!element) return []
  if (repeatText > 0)
    for (const node of Array.from(element.childNodes))
      if (node.nodeType === Node.TEXT_NODE && node.textContent!.trim())
        node.textContent = Array(repeatText)
          .fill(node.textContent!.trim())
          .join(" ")
  for (const [name, value] of Object.entries(style))
    element.style.setProperty(name, value, "important")
  const range = document.createRange()
  range.selectNodeContents(element)
  return [element.getBoundingClientRect(), range.getBoundingClientRect()]
    .filter((box) => box.width > 0 && box.height > 0)
    .map((box) => ({
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    }))
}
