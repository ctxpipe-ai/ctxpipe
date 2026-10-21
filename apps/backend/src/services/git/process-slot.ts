/**
 * At most this many native Git processes run at one time in this process. An
 * upgrade step reads each file of a Workspace in parallel; one Git process for
 * each file made the operating system refuse a new process (`spawn git
 * EAGAIN`, CTX-952).
 */
const GIT_PROCESS_LIMIT = 8

let running = 0
const waiting: Array<() => void> = []

/**
 * True when the operating system refused to start a process for a temporary
 * cause: too many processes (EAGAIN), too little memory (ENOMEM), or too many
 * open files (EMFILE, ENFILE). A later start can pass.
 */
export function isTemporarySpawnError(error: unknown): boolean {
  const { code, syscall } = (error ?? {}) as NodeJS.ErrnoException
  return (
    typeof syscall === "string" &&
    syscall.startsWith("spawn") &&
    (code === "EAGAIN" ||
      code === "ENOMEM" ||
      code === "EMFILE" ||
      code === "ENFILE")
  )
}

/**
 * Run `start`, which starts one native Git process and settles when the
 * process has exited, in one of the {@link GIT_PROCESS_LIMIT} slots. When the
 * operating system refuses the start for a temporary cause, wait a short
 * time and start again, at most three more times.
 */
export async function withGitProcessSlot<T>(
  start: () => Promise<T>,
): Promise<T> {
  if (running >= GIT_PROCESS_LIMIT)
    await new Promise<void>((resolve) => waiting.push(resolve))
  else running++
  try {
    for (const delay of [250, 1000, 4000]) {
      try {
        return await start()
      } catch (error) {
        if (!isTemporarySpawnError(error)) throw error
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
    return await start()
  } finally {
    // The slot goes to the next caller in the queue, or becomes free.
    const next = waiting.shift()
    if (next) next()
    else running--
  }
}
