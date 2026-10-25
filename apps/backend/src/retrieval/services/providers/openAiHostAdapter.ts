import {
  TransientHttpError,
  withTransientHttpRetry,
} from "../../../lib/withTransientHttpRetry.js"
import {
  HostTextAdapter,
  messageText,
  STRUCTURED_OUTPUT_TOOL,
} from "./hostTextAdapter.js"
import type {
  OpenAiCompatibleFetch,
  ProviderCallOpts,
} from "./providerTypes.js"

/**
 * How a host call asks for structured output. "tool" forces a call to one
 * function tool. "json_schema" sends `response_format`. Some servers (oMLX)
 * ignore a forced `tool_choice` but enforce a JSON schema with a grammar.
 */
export type StructuredOutputMode = "tool" | "json_schema"

function structuredOutputFields(
  mode: StructuredOutputMode,
  name: string,
  schema: unknown,
): Record<string, unknown> {
  if (mode === "json_schema")
    return {
      response_format: { type: "json_schema", json_schema: { name, schema } },
    }
  return {
    tools: [{ type: "function", function: { name, parameters: schema } }],
    tool_choice: { type: "function", function: { name } },
  }
}

function isJson(text: string | undefined): text is string {
  if (text === undefined) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

export function openAiHostAdapter(
  opts: ProviderCallOpts,
  provider: string,
  baseURL: string,
  doFetch: OpenAiCompatibleFetch,
  params?: Record<string, unknown>,
  structuredOutput: StructuredOutputMode = "tool",
): HostTextAdapter {
  const outputName = opts.outputName ?? STRUCTURED_OUTPUT_TOOL
  return new HostTextAdapter(opts, provider, async (options, schema) => {
    const response = await withTransientHttpRetry(
      async () => {
        const response = await doFetch(
          `${baseURL.replace(/\/$/, "")}/chat/completions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: options.request?.signal ?? undefined,
            body: JSON.stringify({
              ...params,
              model: opts.models[0],
              temperature: opts.temperature,
              stream: false,
              ...(schema
                ? structuredOutputFields(structuredOutput, outputName, schema)
                : {}),
              messages: [
                ...(options.systemPrompts ?? []).map((prompt) => ({
                  role: "system",
                  content: typeof prompt === "string" ? prompt : prompt.content,
                })),
                ...options.messages.map((message) => ({
                  role: message.role,
                  content: messageText(message.content),
                })),
              ],
            }),
          },
        )
        if (!response.ok) {
          const message = `Model request failed: ${response.status} ${await response.text()}`
          if (
            [408, 409, 429].includes(response.status) ||
            response.status >= 500
          )
            throw new TransientHttpError(message, response.status)
          throw new Error(message)
        }
        return response
      },
      { retries: 6, signal: options.request?.signal ?? undefined },
    )
    const result = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null
          tool_calls?: Array<{
            function?: { name?: string; arguments?: string }
          }>
        }
      }>
      usage?: {
        prompt_tokens: number
        completion_tokens: number
        total_tokens: number
      }
    }
    const message = result.choices?.[0]?.message
    const text =
      schema && structuredOutput === "tool"
        ? message?.tool_calls?.find(
            (call) => call.function?.name === outputName,
          )?.function?.arguments
        : (message?.content ?? undefined)
    if (schema && structuredOutput === "tool" && text === undefined)
      throw new Error("The model did not call the structured output tool")
    // Callers retry on this message, as they do for a skipped output tool.
    if (schema && structuredOutput === "json_schema" && !isJson(text))
      throw new Error("The model returned no structured output")
    return {
      text: text ?? "",
      usage: result.usage
        ? {
            promptTokens: result.usage.prompt_tokens,
            completionTokens: result.usage.completion_tokens,
            totalTokens: result.usage.total_tokens,
          }
        : undefined,
    }
  })
}
