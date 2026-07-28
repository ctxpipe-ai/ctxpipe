import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

export type StructuralSearchMatch = Record<string, unknown>

function assertWithinCheckout(
  checkoutPath: string,
  candidatePath: string,
): void {
  const relativePath = relative(checkoutPath, candidatePath)
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error("Structural search path escapes checkout")
  }
}

export async function resolveStructuralSearchPaths(
  checkoutPath: string,
  paths: readonly string[],
): Promise<{ checkoutPath: string; paths: string[] }> {
  const resolvedCheckoutPath = await realpath(checkoutPath)
  const resolvedPaths = await Promise.all(
    paths.map(async (path) => {
      const resolvedPath = await realpath(resolve(resolvedCheckoutPath, path))
      assertWithinCheckout(resolvedCheckoutPath, resolvedPath)
      return resolvedPath
    }),
  )
  return { checkoutPath: resolvedCheckoutPath, paths: resolvedPaths }
}

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

async function parseMatch(
  line: string,
  checkoutPath: string,
): Promise<StructuralSearchMatch> {
  const value: unknown = JSON.parse(line)
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("ast-grep returned an invalid JSON match")
  }
  if (typeof (value as StructuralSearchMatch).file !== "string") {
    throw new Error("ast-grep returned a match without a file path")
  }
  const matchPath = await realpath(
    resolve(checkoutPath, (value as StructuralSearchMatch).file as string),
  )
  assertWithinCheckout(checkoutPath, matchPath)
  return value as StructuralSearchMatch
}

async function readMatches(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  checkoutPath: string,
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
      if (line && matches.length < limit) {
        matches.push(await parseMatch(line, checkoutPath))
      }
      newline = pending.indexOf("\n")
    }

    if (done) break
  }

  const finalLine = pending.trim()
  if (finalLine && matches.length < limit) {
    matches.push(await parseMatch(finalLine, checkoutPath))
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
  const resolved = await resolveStructuralSearchPaths(
    input.checkoutPath,
    input.paths,
  )
  const argv = buildAstGrepArgv({ ...input, paths: resolved.paths })
  const subprocess = Bun.spawn(argv, {
    cwd: resolved.checkoutPath,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [matches, stderr, exitCode] = await Promise.all([
    readMatches(subprocess.stdout, input.limit, resolved.checkoutPath),
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
