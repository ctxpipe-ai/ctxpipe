import type { ProviderCallEnv } from "./providerTypes.js"

export function resolveBedrockRegion(env: ProviderCallEnv): string {
  const region =
    env.MODEL_BEDROCK_AWS_REGION?.trim() ||
    env.AWS_REGION?.trim() ||
    env.AWS_DEFAULT_REGION?.trim()
  if (!region) {
    throw new Error(
      "Bedrock requires AWS region: set MODEL_BEDROCK_AWS_REGION, AWS_REGION, or AWS_DEFAULT_REGION",
    )
  }
  return region
}
