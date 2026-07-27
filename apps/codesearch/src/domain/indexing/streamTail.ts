/** Keep only the trailing bytes of a long-lived child process stream. */
export const INDEX_CHILD_LOG_TAIL_BYTES = 128 * 1024

/**
 * Drain a ReadableStream while retaining at most `maxBytes` of the end.
 * Avoids holding multi-GB of zoekt/cgc logs in the Bun heap until process exit.
 */
export async function readStreamTail(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
): Promise<string> {
  if (!stream || maxBytes <= 0) {
    if (stream) {
      await stream.cancel().catch(() => undefined)
    }
    return ""
  }

  const reader = stream.getReader()
  let buf = new Uint8Array(0)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.byteLength) continue
      const next = new Uint8Array(buf.byteLength + value.byteLength)
      next.set(buf)
      next.set(value, buf.byteLength)
      buf =
        next.byteLength > maxBytes
          ? next.subarray(next.byteLength - maxBytes)
          : next
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder().decode(buf)
}
