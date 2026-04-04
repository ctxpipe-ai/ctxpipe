/**
 * Baseline provider: direct OpenAI-compatible chat completion (no MCP, no org context).
 * Promptfoo passes the rendered prompt; we prefer `context.vars.question` when set.
 */
export default class BaselineProvider {
  id = () => "baseline-no-ctxpipe"

  /**
   * @param {string} prompt
   * @param {object} context
   * @param {object} [options]
   */
  callApi = async (prompt, context, options) => {
    const config = options?.config ?? {}
    const model = config.model ?? "gpt-4o-mini"
    const temperature = config.temperature ?? 0
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      return { error: "OPENAI_API_KEY is not set" }
    }
    const baseUrl = (
      process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
    ).replace(/\/$/, "")
    const system =
      config.system ??
      [
        "You are a helpful assistant. Answer clearly and concisely.",
        "You do not have access to organizational memory, MCP tools, or private org knowledge bases.",
      ].join(" ")
    const user = context?.vars?.question ?? prompt

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      return { error: `Chat API error ${res.status}: ${err}` }
    }

    const data = await res.json()
    const text = data.choices?.[0]?.message?.content ?? ""
    return {
      output: typeof text === "string" ? text : JSON.stringify(text),
    }
  }
}
