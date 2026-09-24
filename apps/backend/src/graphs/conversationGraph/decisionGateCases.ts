import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { z } from "zod"

/** Labelled prompts and production decisions under `evals/decision-gate/`. */
const evalDir = fileURLToPath(
  new URL("../../../evals/decision-gate/", import.meta.url),
)

const DecisionRowSchema = z.object({
  path: z.string().optional(),
  name: z.string(),
  summary: z.string().optional(),
  status: z.string().optional(),
})

const CaseSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  escalate: z.boolean(),
  covering: z.array(z.string()).nullable(),
  exclude: z.array(z.string()).optional(),
  inject: z
    .array(
      DecisionRowSchema.extend({
        kind: z.string(),
        corrects: z.string().nullable().optional(),
        modality: z.string().optional(),
        source_tier: z.number().optional(),
      }),
    )
    .optional(),
})

export type DecisionRow = z.infer<typeof DecisionRowSchema>
export type DecisionGateCase = z.infer<typeof CaseSchema>

export function decisionGateCasesExist(file: string): boolean {
  return existsSync(`${evalDir}${file}`)
}

export function readDecisionGateCases(file: string): DecisionGateCase[] {
  const raw: unknown = JSON.parse(readFileSync(`${evalDir}${file}`, "utf8"))
  return z.object({ cases: z.array(CaseSchema) }).parse(raw).cases
}

export function readProductionDecisions(): DecisionRow[] {
  const raw: unknown = JSON.parse(
    readFileSync(`${evalDir}decisions.json`, "utf8"),
  )
  return z.object({ decisions: z.array(DecisionRowSchema) }).parse(raw)
    .decisions
}
