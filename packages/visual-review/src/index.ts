// The visual critic. A caller builds a StoryInput for each changed story and
// calls `review` with a Judge (a model adapter), or shows `buildPrompt` to a
// coding agent and reads its answer with `parseVerdict`.
export { buildPrompt } from "./prompt.ts"
export type { Prompt } from "./prompt.ts"
export { review } from "./review.ts"
export type { Judge, JudgeReply } from "./review.ts"
export { areas, qualities } from "./rubric.ts"
export type { Box, Region, StoryImage, StoryInput } from "./story.ts"
export { judgementJsonSchema, parseVerdict } from "./verdict.ts"
export type { RunFacts, Verdict } from "./verdict.ts"
