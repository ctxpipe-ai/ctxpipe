import { buildPrompt, type Prompt } from "./prompt.ts"
import type { StoryInput } from "./story.ts"
import { parseVerdict, type Verdict } from "./verdict.ts"

/** The reply of a judge: its text, the model id, and the cost in USD (null when unknown). */
export type JudgeReply = { text: string; model: string; costUsd: number | null }

/**
 * A judge sends one prompt to a model (or to a coding agent) and returns the
 * reply. A model adapter sends the prefix first and marks it for the provider
 * cache, then the story part, then the images in their order. A judge throws
 * when it gets no reply; it does not turn a transport error into text.
 */
export type Judge = (prompt: Prompt) => Promise<JudgeReply>

/**
 * Review one story with a judge. The verdict has the measured latency of the
 * judge call. A reply that is not a valid judgement gives `unsure` (see
 * `parseVerdict`); an error of the judge goes to the caller.
 */
export async function review(
  story: StoryInput,
  judge: Judge,
): Promise<Verdict> {
  const started = Date.now()
  const { text, model, costUsd } = await judge(buildPrompt(story))
  return parseVerdict(text, story, {
    model,
    costUsd,
    latencyMs: Date.now() - started,
  })
}
