/** Node vitest has no `sessionStorage`; stories and the browser do. */

export function installMemorySessionStorage(): { clear: () => void } {
  const map = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return map.size
    },
    clear() {
      map.clear()
    },
    getItem(key) {
      return map.get(key) ?? null
    },
    key(index) {
      return [...map.keys()][index] ?? null
    },
    removeItem(key) {
      map.delete(key)
    },
    setItem(key, value) {
      map.set(key, value)
    },
  }
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: storage,
  })
  return {
    clear() {
      map.clear()
    },
  }
}
