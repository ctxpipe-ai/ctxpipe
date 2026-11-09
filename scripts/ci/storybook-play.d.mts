// Types of storybook-play.mjs for the TypeScript callers.
import type { Server } from "node:http"

/** An entry of the Storybook index.json. */
export type IndexStory = {
  id: string
  title: string
  importPath: string
  type?: string
  tags?: string[]
}

/** The part of a Playwright page that the callers use. */
export type PlayPage = {
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<Awaited<R>>
  screenshot(options: {
    type: "png"
    animations: "disabled"
    fullPage?: boolean
    style?: string
  }): Promise<Buffer>
  waitForTimeout(ms: number): Promise<void>
}

export function serveStatic(directory: string, port: number): Promise<Server>

export function waitFor(url: string): Promise<void>

export function playStories(
  storybookUrl: string,
  stories: readonly IndexStory[],
  onStory: (
    story: IndexStory,
    outcome: { error?: string },
  ) => void | Promise<void>,
  options?: {
    trace?: boolean
    beforePlay?: (page: PlayPage, story: IndexStory) => Promise<void>
    afterPlay?: (
      page: PlayPage,
      story: IndexStory,
      error: string | undefined,
    ) => Promise<void>
    viewport?: { width: number; height: number }
  },
): Promise<void>
