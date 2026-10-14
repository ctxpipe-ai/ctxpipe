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

export function openAiHostAdapter(
  opts: ProviderCallOpts,
  provider: string,
  baseURL: string,
  doFetch: OpenAiCompatibleFetch,
  params?: Record<string, unknown>,
): HostTextAdapter {
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
                ? {
                    tools: [
                      {
                        type: "function",
                        function: {
                          name: opts.outputName ?? STRUCTURED_OUTPUT_TOOL,
                          parameters: schema,
                        },
                      },
                    ],
                    tool_choice: {
                      type: "function",
                      function: {
                        name: opts.outputName ?? STRUCTURED_OUTPUT_TOOL,
                      },
                    },
                  }
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
    const text = schema
      ? message?.tool_calls?.find(
          (call) =>
            call.function?.name === (opts.outputName ?? STRUCTURED_OUTPUT_TOOL),
        )?.function?.arguments
      : message?.content
    if (schema && text === undefined)
      throw new Error("The model did not call the structured output tool")
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
