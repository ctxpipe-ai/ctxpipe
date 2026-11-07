// The visual critic. For each changed story, a caller builds a StoryInput,
// sends `buildPrompt` to a model or to a coding agent, and reads the reply
// with `parseVerdict`.
export {
  judgeWithOpenRouter,
  openRouterModelId,
  openRouterPrices,
  usageCost,
} from "./adapters/openrouter.ts"
export { buildPrompt } from "./prompt.ts"
export type { Prompt } from "./prompt.ts"
export { areas, qualities } from "./rubric.ts"
export type { Box, Region, StoryImage, StoryInput } from "./story.ts"
export { judgementJsonSchema, parseVerdict, verdictSchema } from "./verdict.ts"
export type { RunFacts, Verdict } from "./verdict.ts"
