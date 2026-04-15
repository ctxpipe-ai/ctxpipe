/**
 * Composable stream enhancer for conversation renaming.
 * Rename is emitted via LangGraph `custom` stream (`getWriter` in conversationNaming)
 * so it interleaves with assistant tokens — this enhancer only runs optional onFinish.
 */

export interface StreamEnhancer {
  wrapGraphStream(stream: AsyncIterable<unknown>): AsyncIterable<unknown>
  getFlushTransform(): TransformStream<unknown, unknown>
}

export function createRenameStreamEnhancer(input: {
  source?: string
  onFinish?: () => Promise<void> | void
}): StreamEnhancer {
  return {
    wrapGraphStream(stream: AsyncIterable<unknown>) {
      return stream
    },
    getFlushTransform() {
      return new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk)
        },
        async flush() {
          await input.onFinish?.()
        },
      })
    },
  }
}
