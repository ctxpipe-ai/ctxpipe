import { otelDeploymentEnvironment } from "../observability/otel.js"

function publicOriginFromAuthBaseUrl(
  raw = process.env.AUTH_BASE_URL,
): string | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  try {
    return new URL(trimmed).origin
  } catch {
    return undefined
  }
}

/** Non-secret process identity for advisor turns. Retrieved docs are not this. */
export function advisorRuntimeContext(): string {
  const deploymentEnvironment = otelDeploymentEnvironment()
  const publicOrigin = publicOriginFromAuthBaseUrl()
  const lines = [
    "This process (runtime metadata, not retrieved documents):",
    `- deployment.environment: ${deploymentEnvironment}`,
  ]
  if (publicOrigin) lines.push(`- public origin: ${publicOrigin}`)
  lines.push(
    "Retrieved documents may mention other environment ids or hosts; those are not this process.",
    "Do not claim this process's environment or origin unless it appears in this block. If this block is absent, say those values are unknown.",
  )
  return lines.join("\n")
}

export function mcpAdvisorUserPrompt(input: {
  prompt: string
  currentProjectName?: string
}): string {
  const project = input.currentProjectName
    ? `Project: ${input.currentProjectName}\n\n`
    : ""
  return `${advisorRuntimeContext()}\n\n${project}${input.prompt}`
}
