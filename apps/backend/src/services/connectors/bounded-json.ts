/**
 * Read the JSON body of a provider answer, at most `maxBytes`. The read stops
 * when the body passes the limit, so one provider answer cannot fill the
 * memory of the backend or the worker.
 */
export async function readBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const tooLarge = () =>
    new Error(`The provider answer is larger than ${maxBytes} bytes`)
  // The cancel is not awaited: a stream can wait for its source to stop,
  // and the error must not wait for that.
  if (Number(response.headers.get("content-length")) > maxBytes) {
    response.body?.cancel().catch(() => {})
    throw tooLarge()
  }
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body?.getReader()
  for (;;) {
    const next = await reader?.read()
    if (!next || next.done) break
    size += next.value.byteLength
    if (size > maxBytes) {
      reader?.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(next.value)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}
