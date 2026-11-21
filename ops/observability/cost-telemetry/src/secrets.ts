import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager"

import { fetchHandler, ProviderError } from "./http"

// The provider inputs. Each comes from its env var (local runs and tests), else, in the ECS task, from the secret
// `cost-telemetry/<NAME>`: ECS cannot start a task while an injected secret is empty, so the task reads them itself,
// and one missing secret fails only its provider.
const INPUTS = [
  "OPENROUTER_MANAGEMENT_KEY",
  "GITHUB_BILLING_TOKEN",
  "BLACKSMITH_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "LINEAR_CLIENT_ID",
  "LINEAR_CLIENT_SECRET",
]

let loaded = new Map<string, string | ProviderError>()

/**
 * In the ECS task (ECS sets its metadata endpoint), reads each provider input that the env does not set from Secrets
 * Manager, once per run (the task role; region AWS_REGION, else us-west-2). A local run reads env vars only. Returns
 * `<NAME>:<class>` for each input that it could not read: never a value.
 */
export async function loadProviderInputs(): Promise<string[]> {
  loaded = new Map()
  const names = INPUTS.filter((name) => !process.env[name]?.trim())
  if (!process.env.ECS_CONTAINER_METADATA_URI_V4 || names.length === 0)
    return []
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION?.trim() || "us-west-2",
    requestHandler: fetchHandler(),
  })
  try {
    await Promise.all(
      names.map(async (name) =>
        loaded.set(name, await read(client, `cost-telemetry/${name}`, name)),
      ),
    )
  } finally {
    client.destroy()
  }
  return names.flatMap((name) => {
    const value = loaded.get(name)
    return value instanceof ProviderError ? [`${name}:${value.kind}`] : []
  })
}

async function read(
  client: SecretsManagerClient,
  secretId: string,
  name: string,
): Promise<string | ProviderError> {
  try {
    const value = (
      await client.send(new GetSecretValueCommand({ SecretId: secretId }))
    ).SecretString?.trim()
    return (
      value ||
      new ProviderError(
        "missing_env",
        `${name} has no value in Secrets Manager`,
      )
    )
  } catch (err) {
    // A secret that does not exist, or that has no AWSCURRENT version, is missing.
    if (err instanceof Error && err.name === "ResourceNotFoundException") {
      return new ProviderError(
        "missing_env",
        `${name} is not in Secrets Manager`,
      )
    }
    return new ProviderError(
      "secret_read",
      `${name} could not be read from Secrets Manager`,
    )
  }
}

/** Drops the secrets that loadProviderInputs read, at the end of the providers of a run. */
export function forgetProviderInputs(): void {
  loaded = new Map()
}

/** A provider input: its env var, else the secret that loadProviderInputs read. Missing, it fails the provider. */
export function providerInput(name: string): string {
  const env = process.env[name]?.trim()
  if (env) return env
  const value = loaded.get(name)
  if (typeof value === "string") return value
  throw value ?? new ProviderError("missing_env", `${name} is required`)
}
