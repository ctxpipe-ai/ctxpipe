import type { PoolClient } from "pg"
import {
  type ConnectionSecretKeyEnv,
  decryptConnectionSecret,
  encryptConnectionSecret,
  isEncryptedConnectionSecret,
} from "../lib/connection-secrets.js"

type Counts = { rows: number; rotated: number; alreadyNewKey: number }

type ReencryptReport = {
  applied: boolean
  connections: Counts
  sandboxGitTokens: Counts
}

/**
 * Re-encrypts each stored connection secret from the `from` key to the `to`
 * key: every `ctxv1:` string in `connections.config`, and
 * `workspace_sandbox_git_tokens.token_ciphertext`.
 *
 * One transaction holds all rows. Without `apply`, it rolls back, so a dry
 * run proves that each value decrypts. A value that the `to` key already
 * decrypts stays as it is, so a second run does nothing. When a value
 * decrypts with neither key, it rolls back and names each location.
 *
 * `client` must bypass row-level security (the table owner), else it sees no
 * rows. `orgId` limits the run to one org.
 */
export async function reencryptConnectionSecrets(input: {
  client: PoolClient
  from: ConnectionSecretKeyEnv
  to: ConnectionSecretKeyEnv
  apply: boolean
  orgId?: string
}): Promise<ReencryptReport> {
  const { client, from, to } = input
  if (decryptsWith(encryptConnectionSecret("probe", to), from)) {
    throw new Error("The old key and the new key are the same key")
  }
  const failures: string[] = []
  const rotate = (value: string, where: string, counts: Counts): string => {
    if (decryptsWith(value, to)) {
      counts.alreadyNewKey++
      return value
    }
    try {
      const out = encryptConnectionSecret(
        decryptConnectionSecret(value, from),
        to,
      )
      counts.rotated++
      return out
    } catch {
      failures.push(where)
      return value
    }
  }
  const report: ReencryptReport = {
    applied: false,
    connections: { rows: 0, rotated: 0, alreadyNewKey: 0 },
    sandboxGitTokens: { rows: 0, rotated: 0, alreadyNewKey: 0 },
  }

  await client.query("begin")
  try {
    const rls = await client.query<{ active: boolean }>(
      `select row_security_active('connections') or row_security_active('workspace_sandbox_git_tokens') as active`,
    )
    if (rls.rows[0]?.active) {
      throw new Error(
        "Row-level security hides rows from this database role. Use the owner DATABASE_URL, not ctxpipe_app.",
      )
    }

    const connections = await client.query<{
      id: string
      config: Record<string, unknown>
    }>(
      "select id, config from connections where $1::text is null or org_id = $1 for update",
      [input.orgId ?? null],
    )
    for (const row of connections.rows) {
      const before = report.connections.rotated
      const config = mapStrings(
        row.config,
        `connections[${row.id}].config`,
        (value, where) =>
          isEncryptedConnectionSecret(value)
            ? rotate(value, where, report.connections)
            : value,
      )
      if (report.connections.rotated === before) continue
      await client.query(
        "update connections set config = $2::jsonb where id = $1",
        [row.id, JSON.stringify(config)],
      )
      report.connections.rows++
    }

    const tokens = await client.query<{
      sandbox_id: string
      token_ciphertext: string
    }>(
      "select sandbox_id, token_ciphertext from workspace_sandbox_git_tokens where $1::text is null or org_id = $1 for update",
      [input.orgId ?? null],
    )
    for (const row of tokens.rows) {
      const where = `workspace_sandbox_git_tokens[${row.sandbox_id}]`
      const token = rotate(row.token_ciphertext, where, report.sandboxGitTokens)
      if (token === row.token_ciphertext) continue
      await client.query(
        "update workspace_sandbox_git_tokens set token_ciphertext = $2 where sandbox_id = $1",
        [row.sandbox_id, token],
      )
      report.sandboxGitTokens.rows++
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} values decrypt with neither key. Nothing changed. Locations: ${failures.join(", ")}`,
      )
    }
    await client.query(input.apply ? "commit" : "rollback")
    report.applied = input.apply
    return report
  } catch (error) {
    await client.query("rollback")
    throw error
  }
}

function decryptsWith(
  ciphertext: string,
  key: ConnectionSecretKeyEnv,
): boolean {
  try {
    decryptConnectionSecret(ciphertext, key)
    return true
  } catch {
    return false
  }
}

function mapStrings(
  value: unknown,
  where: string,
  map: (value: string, where: string) => string,
): unknown {
  if (typeof value === "string") return map(value, where)
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      mapStrings(item, `${where}[${index}]`, map),
    )
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        mapStrings(item, `${where}.${key}`, map),
      ]),
    )
  }
  return value
}
