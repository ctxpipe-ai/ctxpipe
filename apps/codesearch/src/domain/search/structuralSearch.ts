export type StructuralSearchMatch = Record<string, unknown>

export function buildAstGrepArgv(input: {
  pattern: string
  lang?: string
  globs?: readonly string[]
  paths: readonly string[]
}): string[] {
  const argv = ["ast-grep", "run", "--pattern", input.pattern, "--json=stream"]
  if (input.lang) argv.push("--lang", input.lang)
  for (const glob of input.globs ?? []) {
    argv.push("--globs", glob)
  }
  argv.push("--", ...input.paths)
  return argv
}

function parseMatch(line: string): StructuralSearchMatch {
  const value: unknown = JSON.parse(line)
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("ast-grep returned an invalid JSON match")
  }
  return value as StructuralSearchMatch
}

async function readMatches(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<StructuralSearchMatch[]> {
  if (!stream) return []

  const matches: StructuralSearchMatch[] = []
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ""

  while (true) {
    const { done, value } = await reader.read()
    pending += decoder.decode(value, { stream: !done })

    let newline = pending.indexOf("\n")
    while (newline >= 0) {
      const line = pending.slice(0, newline).trim()
      pending = pending.slice(newline + 1)
      if (line && matches.length < limit) matches.push(parseMatch(line))
      newline = pending.indexOf("\n")
    }

    if (done) break
  }

  const finalLine = pending.trim()
  if (finalLine && matches.length < limit) {
    matches.push(parseMatch(finalLine))
  }
  return matches
}

export async function runStructuralSearch(input: {
  checkoutPath: string
  pattern: string
  lang?: string
  globs?: readonly string[]
  paths: readonly string[]
  limit: number
}): Promise<StructuralSearchMatch[]> {
  const argv = buildAstGrepArgv(input)
  const subprocess = Bun.spawn(argv, {
    cwd: input.checkoutPath,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [matches, stderr, exitCode] = await Promise.all([
    readMatches(subprocess.stdout, input.limit),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(
      `ast-grep failed with exit code ${exitCode}${
        stderr.trim() ? `: ${stderr.trim()}` : ""
      }`,
    )
  }
  return matches
}
