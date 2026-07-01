import {
  paramsToModelParams,
  type ModelParams,
} from "./modelParams.js"

export {
  mergeModelParams,
  paramsToModelParams,
  REASONING_EFFORT_VALUES,
  type ModelParams,
  type ReasoningEffort,
  type Verbosity,
  VERBOSITY_VALUES,
} from "./modelParams.js"

export type ParsedModelSpec = {
  readonly modelId: string
  readonly params: Record<string, string>
}

export function parseModelSpec(raw: string): ParsedModelSpec {
  const trimmed = raw.trim()
  const queryIndex = trimmed.indexOf("?")
  if (queryIndex === -1) {
    return { modelId: trimmed, params: {} }
  }

  const modelId = trimmed.slice(0, queryIndex).trim()
  const params: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(trimmed.slice(queryIndex + 1))) {
    params[key] = value
  }

  return { modelId, params }
}

export function modelSpecBase(raw: string): string {
  return parseModelSpec(raw).modelId
}

export function modelParamsFromSpec(spec: string): ModelParams {
  const { params } = parseModelSpec(spec)
  if (Object.keys(params).length === 0) {
    return {}
  }
  return paramsToModelParams(params)
}
