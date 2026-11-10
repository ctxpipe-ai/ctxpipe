/**
 * An async mutex for each key: `run(key, fn)` starts `fn` after each earlier
 * `fn` of the same key has settled. Different keys do not wait.
 */
export function keyedMutex<K>(): {
  run: <T>(key: K, fn: () => Promise<T>) => Promise<T>
  clear: () => void
} {
  const queues = new Map<K, Promise<void>>()
  return {
    run: async (key, fn) => {
      const previous = queues.get(key) ?? Promise.resolve()
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const next = previous.catch(() => {}).then(() => gate)
      queues.set(key, next)
      await previous.catch(() => {})
      try {
        return await fn()
      } finally {
        release()
        if (queues.get(key) === next) queues.delete(key)
      }
    },
    clear: () => queues.clear(),
  }
}
