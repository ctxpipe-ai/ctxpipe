/**
 * Takes a named screenshot of the story at this point of its play function.
 * The baseline is
 * `<story file dir>/screenshots/<storyfile>.<storyname>@<name>.<viewport>.screenshot.png`.
 *
 * Use a string literal in kebab case for `name`, in the play function of the
 * story itself: `checks:list` and `pnpm visual:check` read the names from the
 * story file. The screenshot capture (scripts/ci/visual-capture.mjs) gives
 * the page the binding that takes the shot. In any other browser, this does
 * nothing.
 */
export async function snapshot(name: string): Promise<void> {
  const take = (
    window as Window & {
      __ctxpipeSnapshot?: (name: string) => Promise<void>
    }
  ).__ctxpipeSnapshot
  await take?.(name)
}
