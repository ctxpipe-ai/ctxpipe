// Makes the viewport of a page as high as its content, for a full-page
// screenshot (scripts/ci/visual-capture.mjs). Playwright's `fullPage` takes
// only the scroll height of the document. A workspace page has the height of
// the viewport (`h-svh`) and its panes scroll inside, so `fullPage` alone
// does not show the content below the fold of a pane. A higher viewport
// makes such a pane higher, until its content fits. The document is a scroll
// container too, so a long page also gets a viewport of its full height, and
// a sticky side navigation (`h-screen`) goes down to the end of the page.
//
// A scroll container whose height does not change with the viewport (a list
// with `max-h-64`) cannot show all of its content this way, and neither can
// one whose content grows with it (a child with `h-full` and a margin). Thus
// the first step only probes: it makes the viewport 8 px higher. A container
// that then has the same height, or not less hidden content, is fixed, and
// the viewport does not grow for it. The document can be fixed too
// (Storybook adds a padding around a story of the viewport height); then
// `fullPage` takes the rest. When only fixed containers have hidden content,
// the viewport gets its first height again.
//
// It does at most 8 steps (content that a higher pane renders, for example
// more rows of a virtual list, can need one more step). The width does not
// change.

// The highest viewport, and the highest screenshot, in pixels.
export const maxHeight = 10_000

// Returns a function that gives the page its viewport and its scroll
// positions again (a dialog that the play scrolled into view stays in view);
// the caller calls it after the shot.
export async function growToContent(page) {
  const before = page.viewportSize()
  // The scroll position of each element that has one.
  const scrolled = await page.evaluateHandle(() =>
    [document.scrollingElement, ...document.body.querySelectorAll("*")]
      .filter((element) => element.scrollTop || element.scrollLeft)
      .map((element) => [element, element.scrollTop, element.scrollLeft]),
  )
  const restore = async () => {
    await resize(page, before)
    await scrolled.evaluate((positions) => {
      for (const [element, top, left] of positions)
        element.scrollTo({ top, left, behavior: "instant" })
    })
  }
  const fixedScrollers = new Set()
  let previousSizes
  let height = before.height
  for (let step = 0; step < 8; step++) {
    const sizes = await page.evaluate(measureScrollers)
    let largestHidden = 0
    for (const { id, clientHeight, hidden } of sizes) {
      if (fixedScrollers.has(id)) continue
      const previous = previousSizes?.get(id)
      if (
        previous &&
        (previous.clientHeight === clientHeight || previous.hidden <= hidden)
      )
        fixedScrollers.add(id)
      else largestHidden = Math.max(largestHidden, hidden)
    }
    if (largestHidden <= 0 || height >= maxHeight) {
      // Only the probe changed the viewport.
      if (step === 1) await resize(page, before)
      break
    }
    height = Math.min(height + (previousSizes ? largestHidden : 8), maxHeight)
    previousSizes = new Map(sizes.map((size) => [size.id, size]))
    await resize(page, { width: before.width, height })
  }
  return restore
}

// Sets the viewport, and waits two frames: the page reacts to the resize
// event in a later task (React Aria sets `--visual-viewport-height`, the
// height of a modal).
//
// The overlay of a React Aria modal has the scroll height of the document
// (`--page-height`), which it measures when the viewport changes. That
// height includes the overlay itself, so the document would stay high after
// the viewport gets smaller. Thus the overlay has no height, and clips its
// content, while the page measures it.
async function resize(page, size) {
  const flat = await page.addStyleTag({
    content:
      '[style*="--page-height"] { height: 0 !important; overflow: hidden !important; }',
  })
  await page.setViewportSize(size)
  await page.evaluate(
    () =>
      new Promise((frame) =>
        requestAnimationFrame(() => requestAnimationFrame(frame)),
      ),
  )
  await flat.evaluate((style) => style.remove())
}

// Runs in the page. Returns the id, the height and the hidden height of the
// document (id 0) and of each visible scroll container with hidden content.
// The id of an element stays the same between calls.
function measureScrollers() {
  const known = (window.__ctxpipeScrollers ??= { ids: new WeakMap(), count: 0 })
  const page = document.scrollingElement
  const sizes = [
    {
      id: 0,
      clientHeight: window.innerHeight,
      hidden: page.scrollHeight - window.innerHeight,
    },
  ]
  for (const element of document.body.querySelectorAll("*")) {
    const style = getComputedStyle(element)
    const hidden = element.scrollHeight - element.clientHeight
    if (
      hidden <= 1 ||
      element.clientHeight === 0 ||
      !/auto|scroll/.test(style.overflowY) ||
      style.visibility !== "visible"
    )
      continue
    // A drawer that slides in from the side is outside of the viewport.
    const box = element.getBoundingClientRect()
    if (box.right <= 0 || box.left >= window.innerWidth) continue
    if (!known.ids.has(element)) known.ids.set(element, (known.count += 1))
    sizes.push({
      id: known.ids.get(element),
      clientHeight: element.clientHeight,
      hidden,
    })
  }
  return sizes
}
