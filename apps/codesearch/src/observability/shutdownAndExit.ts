/** Flush, then exit so a PID 1 shell waiting on bun is not stuck until SIGKILL. */
export async function shutdownAndExit(
  shutdown: () => Promise<void>,
): Promise<void> {
  try {
    await shutdown()
  } finally {
    process.exit(0)
  }
}
