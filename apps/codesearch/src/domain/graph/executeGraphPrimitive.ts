import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export type GraphPrimitiveName =
  | "find_symbol"
  | "get_callers"
  | "get_callees"
  | "get_imports"
  | "get_type_hierarchy"
  | "get_containing_scope"
  | "trace_path"

export type CgcGraphPayload = {
  primitive: GraphPrimitiveName
  kuzuDbPath: string
  repoPath: string
  symbol?: string
  filePath?: string
  module?: string
  maxDepth?: number
  limit?: number
  endSymbol?: string
}

export type CgcGraphResult = {
  ok: boolean
  results: Record<string, unknown>[]
  note?: string
  error?: string
  stderr?: string
}

const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/cgc_graph_query.py",
)

function pythonBinary(): string {
  return process.env.PYTHON_BIN ?? "python3"
}

async function readStream(
  stream: NodeJS.ReadableStream | null,
): Promise<string> {
  if (!stream) return ""
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

export async function executeCgcGraphQuery(
  payload: CgcGraphPayload,
): Promise<CgcGraphResult> {
  if (!existsSync(payload.kuzuDbPath)) {
    return {
      ok: true,
      results: [],
      note: "Code graph database not found for this checkout (run repository indexing).",
    }
  }

  const body = JSON.stringify(payload)

  const subprocess = spawn(pythonBinary(), [scriptPath], {
    env: {
      ...process.env,
      KUZUDB_PATH: payload.kuzuDbPath,
      DATABASE_TYPE: "kuzudb",
    },
  })

  subprocess.stdin.write(body)
  subprocess.stdin.end()

  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(subprocess.stdout),
    readStream(subprocess.stderr),
    new Promise<number>((resolve, reject) => {
      subprocess.on("error", reject)
      subprocess.on("close", (code) => resolve(code ?? 1))
    }),
  ])

  if (exitCode !== 0) {
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = JSON.parse(stdout) as Record<string, unknown>
    } catch {
      parsed = null
    }
    const errMsg =
      (parsed?.error as string | undefined) ??
      (stdout.trim() || "Code graph query failed")
    return {
      ok: false,
      results: [],
      error: errMsg,
      stderr: stderr.trim() || undefined,
      note: stderr.trim()
        ? `CGC stderr: ${stderr.trim()}`
        : `CGC exited with code ${exitCode}`,
    }
  }

  try {
    const parsed = JSON.parse(stdout) as {
      ok?: boolean
      results?: Record<string, unknown>[]
      note?: string
      error?: string
    }
    if (!parsed.ok) {
      return {
        ok: false,
        results: [],
        error: parsed.error ?? "Code graph query failed",
        stderr: stderr.trim() || undefined,
        note: stderr.trim() ? `CGC stderr: ${stderr.trim()}` : undefined,
      }
    }
    return {
      ok: true,
      results: parsed.results ?? [],
      note: parsed.note,
    }
  } catch {
    return {
      ok: false,
      results: [],
      error: stdout.trim() || "Invalid JSON from CGC helper",
      stderr: stderr.trim() || undefined,
    }
  }
}
