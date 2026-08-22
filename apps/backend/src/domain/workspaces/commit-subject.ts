import { fallbackCommitSubject } from "./write-jobs.js"
import { runnerCommitMessage } from "./write-runner.js"

/** Small model, chosen in code — not an operator env. */
export const COMMIT_SUBJECT_MODEL = "anthropic/claude-haiku-4-5"

export function commitSubjectPrompt(input: {
  repoName: string
  trigger?: string
  fileNames: readonly string[]
}): string {
  const names = input.fileNames.slice(0, 12).join(", ")
  return [
    "Write one git commit subject line.",
    `Repository: ${input.repoName}`,
    input.trigger ? `Trigger: ${input.trigger}` : null,
    names ? `Changed files (names only): ${names}` : null,
    "Style: ctxpipe - Knowledge update of <repo> from <trigger>.",
    "No newlines. No file bodies. Under 200 characters.",
  ]
    .filter(Boolean)
    .join("\n")
}

export async function invokeCommitSubjectModel(
  prompt: string,
): Promise<string> {
  const { getModel } = await import("../../retrieval/services/modelProvider.js")
  const model = getModel("fast")
  const result = await model.invoke(prompt)
  const content = result.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part && "text" in part
          ? String(part.text)
          : "",
      )
      .join("")
  }
  return String(content ?? "")
}

export async function generateCommitSubject(input: {
  repoName: string
  trigger?: string
  fileNames: readonly string[]
  generate?: (prompt: string) => Promise<string>
}): Promise<string> {
  const fallback = fallbackCommitSubject({
    repoName: input.repoName,
    trigger: input.trigger,
  })
  const generate = input.generate ?? invokeCommitSubjectModel
  try {
    const raw = await generate(commitSubjectPrompt(input))
    return runnerCommitMessage({
      repoName: input.repoName,
      trigger: input.trigger,
      llmSubject: raw,
    })
  } catch {
    return fallback
  }
}
