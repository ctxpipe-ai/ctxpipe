// The visual critic and its compare engine. For each story screenshot, a
// caller runs `diff` against the baseline, writes the images with
// `writeStoryImages` and the run with `writeManifest`. For each changed story,
// a caller builds a StoryInput with `toStoryInput`, sends `buildPrompt` to a
// model or to a coding agent, and reads the reply with `parseVerdict`.
export {
  judgeWithOpenRouter,
  openRouterModelId,
  openRouterPrices,
  usageCost,
} from "./adapters/openrouter.ts"
export { diff } from "./compare/diff.ts"
export type {
  Comparison,
  MeasuredRegion,
  PixelBox,
  RegionStats,
  Severity,
} from "./compare/diff.ts"
export { writeStoryImages } from "./compare/images.ts"
export type { StoryImages, WrittenImages } from "./compare/images.ts"
export {
  baselinePath,
  manifestJsonSchema,
  toStoryInput,
  writeManifest,
} from "./compare/manifest.ts"
export type { Manifest, ManifestStory } from "./compare/manifest.ts"
export { buildPrompt } from "./prompt.ts"
export type { Prompt } from "./prompt.ts"
export { areas, qualities } from "./rubric.ts"
export type {
  Box,
  ChangeType,
  Position,
  Region,
  StoryImage,
  StoryInput,
} from "./story.ts"
export { judgementJsonSchema, parseVerdict, verdictSchema } from "./verdict.ts"
export type { RunFacts, Verdict } from "./verdict.ts"
export { judgeWithJev } from "./adapters/jev.ts"
