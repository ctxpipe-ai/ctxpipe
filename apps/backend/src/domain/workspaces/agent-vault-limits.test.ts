import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"
import { parse } from "yaml"

import { AGENT_VAULT_RATE_LIMIT_ENV } from "../../../../../packages/aws-cdk/src/internal/agent-vault-limits.js"

// Here, not next to agent-vault-limits.ts: packages/aws-cdk has no YAML parser.
describe("Agent Vault's rate limits in Compose", () => {
  it("are the limits of the AWS sandbox host and the contract tests", async () => {
    const compose = parse(
      await readFile(
        new URL("../../../../../docker-compose.yml", import.meta.url),
        "utf8",
      ),
      { merge: true },
    )
    for (const service of ["agent-vault", "agent-vault-dev"])
      expect(compose.services[service].environment, service).toMatchObject(
        AGENT_VAULT_RATE_LIMIT_ENV,
      )
  })
})
