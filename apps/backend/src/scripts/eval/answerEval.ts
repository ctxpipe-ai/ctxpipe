/**
 * Answer eval (ADR-033 rung 3). Asks the same questions to two or more
 * ctx_advisor targets (e.g. production and a preview), records answers, and
 * grades them: citation grounding (heuristic), graph-kind reach (heuristic),
 * and optionally correctness / "no fake standards" with an LLM judge.
 *
 * Usage (apps/backend):
 *   bun run src/scripts/eval/answerEval.ts \
 *     --questions src/scripts/eval/questions.template.jsonl \
 *     --targets src/scripts/eval/targets.example.json \
 *     --out /tmp/answer-eval.md [--judge] [--limit 10]
 *
 * Targets file: [{ "name": "prod", "url": "https://app.ctxpipe.ai/mcp?orgSlug=acme", "apiKeyEnv": "CTXPIPE_API_KEY_PROD" }]
 * Questions: JSONL rows { id, category, question, expected?, expectedKinds?, expectedUrls? }
 * Env: the API keys named in the targets file; MODEL_PROVIDER* for --judge (apps/backend/.env.local).
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import {
  callCtxAdvisor,
  type EvalGrade,
  type EvalJudgement,
  type EvalQuestion,
  type EvalResult,
  extractCitationUrls,
  gradeHeuristically,
  renderReport,
} from "./answerEvalCore.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../../.env.local") })

type Target = { name: string; url: string; apiKeyEnv: string }

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  const next = index >= 0 ? argv[index + 1] : undefined
  return next !== undefined && !next.startsWith("--") ? next : undefined
}

function readJsonl(path: string): EvalQuestion[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => JSON.parse(line) as EvalQuestion)
}

async function urlResolves(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "follow" })
    return (
      response.status < 400 ||
      response.status === 403 ||
      response.status === 429
    )
  } catch {
    return false
  }
}

async function grade(
  question: EvalQuestion,
  answer: string,
): Promise<EvalGrade> {
  const urls = extractCitationUrls(answer)
  const checks = await Promise.all(urls.map(urlResolves))
  const resolvable = Object.fromEntries(
    urls.map((url, i) => [url, checks[i] ?? false]),
  )
  return gradeHeuristically(question, answer, resolvable)
}

async function judge(
  question: EvalQuestion,
  answer: string,
): Promise<EvalJudgement | undefined> {
  const { getModel } = await import("../../retrieval/services/modelProvider.js")
  const model = getModel("fast", { temperature: 0 })
  const prompt = `You grade an engineering assistant's answer. Respond with JSON only:
{"correct":0|1|2,"grounded":0|1|2,"fakeStandard":true|false,"notes":"<=200 chars"}

correct: 2 = matches the expected answer, 1 = partially, 0 = wrong or missing.
grounded: 2 = cites specific pull requests, issues, decisions or files that support the claim; 1 = vague sources; 0 = none.
fakeStandard: true if the answer presents an issue tracker ticket, chat message or document as an organizational standard or rule.

Question: ${question.question}
Expected (may be empty): ${question.expected ?? ""}
Answer:
${answer.slice(0, 6000)}`
  const response = await model.invoke(prompt)
  const text =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content)
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return undefined
  try {
    return JSON.parse(match[0]) as EvalJudgement
  } catch {
    return undefined
  }
}

async function main(argv: string[]): Promise<void> {
  const questionsPath = flag(argv, "--questions")
  const targetsPath = flag(argv, "--targets")
  const out = flag(argv, "--out")
  if (!questionsPath || !targetsPath || !out) {
    throw new Error(
      "--questions <jsonl> --targets <json> --out <md> are required",
    )
  }
  const limit = Number(flag(argv, "--limit") ?? Number.POSITIVE_INFINITY)
  const useJudge = argv.includes("--judge")
  const questions = readJsonl(questionsPath).slice(0, limit)
  const targets = JSON.parse(readFileSync(targetsPath, "utf8")) as Target[]

  const results: EvalResult[] = []
  for (const target of targets) {
    const apiKey = process.env[target.apiKeyEnv]
    if (!apiKey)
      throw new Error(
        `Missing env ${target.apiKeyEnv} for target ${target.name}`,
      )
    for (const question of questions) {
      const started = Date.now()
      try {
        const answer = await callCtxAdvisor(target, apiKey, question.question)
        const graded = await grade(question, answer)
        if (useJudge) graded.judge = await judge(question, answer)
        results.push({
          target: target.name,
          question,
          answer,
          ms: Date.now() - started,
          grade: graded,
        })
        process.stderr.write(
          `${target.name} ${question.id} ok (${Date.now() - started} ms)\n`,
        )
      } catch (error) {
        results.push({
          target: target.name,
          question,
          answer: "",
          ms: Date.now() - started,
          grade: { citations: 0, groundedUrls: 0, kindsHit: [] },
          error: error instanceof Error ? error.message : String(error),
        })
        process.stderr.write(`${target.name} ${question.id} failed\n`)
      }
    }
  }
  writeFileSync(out, `${renderReport(results, targets)}\n`)
  process.stdout.write(`wrote ${out}\n`)
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
})
