import { Pool } from "pg"

/** Short probe so integration tests skip cleanly when Postgres is down (e.g. CI without Docker). */
export async function isPostgresReachable(
  connectionString: string,
  timeoutMs = 2000,
): Promise<boolean> {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: timeoutMs })
  try {
    const client = await pool.connect()
    client.release()
    await pool.end()
    return true
  } catch {
    try {
      await pool.end()
    } catch {
      // ignore
    }
    return false
  }
}
