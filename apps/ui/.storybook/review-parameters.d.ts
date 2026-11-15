/**
 * What the visual critic knows about a story (`parameters.review`). The story
 * review check (scripts/ci/check-story-review.mjs) needs both values for each
 * story, as string literals. See the Storybook skill, "Review annotations".
 */
type StoryReview = {
  /**
   * `page`: a whole screen that a user lands on (with its shell, or a full
   * popup or onboarding screen). `component`: a component, a dialog, a step
   * or a part of a page. In the story, or in the meta for all its stories.
   */
  kind?: "page" | "component"
  /**
   * One sentence in the story itself: what the UI is for, and the state that
   * the story shows. At most 200 characters.
   */
  purpose?: string
}

// A module file, so that the block below augments the Storybook types and
// does not replace them.
export {}

declare module "@storybook/react-vite" {
  interface Parameters {
    review?: StoryReview
  }
}
