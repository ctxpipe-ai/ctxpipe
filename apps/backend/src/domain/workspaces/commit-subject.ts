import { chat } from "@tanstack/ai"
import { fallbackCommitSubject } from "./write-jobs.js"

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
  const model = getModel("fast", {
    model: COMMIT_SUBJECT_MODEL,
    name: "workspace.commit-subject",
  })
  const cancellation = new AbortController()
  const deadline = setTimeout(
    () =>
      cancellation.abort(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      ),
    5_000,
  )
  try {
    return await chat({
      adapter: model,
      messages: [{ role: "user", content: prompt }],
      abortController: cancellation,
      stream: false,
    })
  } finally {
    clearTimeout(deadline)
  }
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
    const subject = raw.trim()
    return subject &&
      subject !== "New conversation" &&
      subject.length < 200 &&
      !/[\r\n]/.test(subject)
      ? subject
      : fallback
  } catch {
    return fallback
  }
}
