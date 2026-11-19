/**
 * The bytes of the regular files `paths` at the commit `sha`, from the object
 * store of the bare shared clone at `clonePath` (CTX-1412). It never reads a
 * working tree, so it never follows a symlink. A path gives null when its
 * tree entry is not a regular file (a symlink, a submodule or a folder),
 * when the commit does not have it, when the clone does not have the
 * commit, or when the blob is larger than `maxBytes` or than the rest of the
 * request limit. With `root`, each path is relative to that folder.
 */
export async function readCommitBlobs(input: {
  clonePath: string
  sha: string
  paths: readonly string[]
  root?: string
  maxBytes: number
}): Promise<Record<string, Buffer | null>> {
  const result: Record<string, Buffer | null> = Object.fromEntries(
    input.paths.map((path) => [path, null]),
  )
  const full = (path: string) => (input.root ? `${input.root}/${path}` : path)
  let listing: Buffer
  try {
    listing = await git(input.clonePath, [
      // A path is a path, never a pattern or a pathspec magic word.
      "--literal-pathspecs",
      "ls-tree",
      "-l",
      "-z",
      input.sha,
      "--",
      ...input.paths.map(full),
    ])
  } catch {
    // The clone or the commit is not there.
    return result
  }
  const blobs = new Map<string, { oid: string; size: number }>()
  for (const entry of listing.toString("utf8").split("\0")) {
    // Only a regular file: mode 100644 or 100755, type blob.
    const match =
      /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64}) +(\d+)\t/.exec(entry)
    if (!match?.[2] || !match[3]) continue
    blobs.set(entry.slice(entry.indexOf("\t") + 1), {
      oid: match[2],
      size: Number(match[3]),
    })
  }
  // The most bytes of all blobs of one request: a blob after it gives null.
  let left = 32 * 1024 * 1024
  const reads: { path: string; oid: string }[] = []
  for (const path of input.paths) {
    const blob = blobs.get(full(path))
    if (!blob || blob.size > input.maxBytes || blob.size > left) continue
    left -= blob.size
    reads.push({ path, oid: blob.oid })
  }
  if (reads.length === 0) return result
  const output = await git(
    input.clonePath,
    ["cat-file", "--batch"],
    `${reads.map(({ oid }) => oid).join("\n")}\n`,
  )
  let at = 0
  for (const { path, oid } of reads) {
    const end = output.indexOf(10, at)
    const header = output.subarray(at, end).toString()
    const size = Number(header.split(" ")[2])
    if (!header.startsWith(`${oid} blob `) || !Number.isInteger(size))
      throw new Error("git cat-file gave an unexpected object")
    result[path] = output.subarray(end + 1, end + 1 + size)
    at = end + 1 + size + 1
  }
  return result
}

/** Run git in the bare clone, and give its output. A failure throws. */
async function git(
  clonePath: string,
  args: string[],
  stdin?: string,
): Promise<Buffer> {
  const subprocess = Bun.spawn(["git", "-C", clonePath, ...args], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
    killSignal: "SIGKILL",
  })
  const [stdout, exitCode] = await Promise.all([
    new Response(subprocess.stdout).arrayBuffer(),
    subprocess.exited,
    new Response(subprocess.stderr).arrayBuffer(),
  ])
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed with ${exitCode}`)
  return Buffer.from(stdout)
}
