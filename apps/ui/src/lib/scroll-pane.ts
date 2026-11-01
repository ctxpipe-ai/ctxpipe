/**
 * Scrolls `element` to the top of the Workspace pane, and scrolls only the
 * pane: `scrollIntoView` also scrolls the outer boxes, which shifts the whole
 * pane. Outside the pane, the page scrolls as usual.
 */
export function scrollToPaneTop(element: HTMLElement) {
  const pane = element.closest<HTMLElement>("[data-settings-scroll]")
  if (!pane) {
    element.scrollIntoView({ block: "start" })
    return
  }
  pane.scrollTop +=
    element.getBoundingClientRect().top - pane.getBoundingClientRect().top
}
