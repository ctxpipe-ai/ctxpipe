/**
 * Story-only manual clock for the skeleton timing stories. It replaces
 * `setTimeout`, `clearTimeout` and `performance.now`, so a play test sets the
 * time itself and the result does not depend on the speed of the machine.
 *
 * Install it before the component starts to load, and call `restore` when the
 * play test ends. While it is installed, do not use `userEvent`, `waitFor` or
 * `findBy*`: they wait on a real timer. Use `press` and `advance` instead.
 */
export function installManualClock() {
  const real = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    now: performance.now.bind(performance),
  }
  // Fake ids are far above the real ones, so a real `clearTimeout` call never
  // meets a fake id by chance.
  let nextId = 1_000_000_000
  let now = real.now()
  const timers = new Map<number, { at: number; run: () => void }>()

  performance.now = () => now
  globalThis.setTimeout = ((run: () => void, ms?: number) => {
    nextId += 1
    timers.set(nextId, { at: now + Math.max(0, ms ?? 0), run })
    return nextId
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id?: number) => {
    if (id !== undefined && timers.delete(id)) return
    // Browser timer functions require the global object as their receiver.
    real.clearTimeout.call(globalThis, id)
  }) as typeof clearTimeout

  /** Let React render what the last event or timer scheduled. */
  const settle = async () => {
    for (let hop = 0; hop < 3; hop += 1) {
      await new Promise<void>((resolve) => {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => resolve()
        channel.port2.postMessage(0)
      })
    }
  }

  return {
    /** Move the time forward and run each timer that falls due, in order. */
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort(([, a], [, b]) => a.at - b.at)[0]
        if (!due) break
        timers.delete(due[0])
        now = Math.max(now, due[1].at)
        due[1].run()
        await settle()
      }
      now = end
      await settle()
    },
    /** Press a button with a plain click, which needs no timer. */
    async press(button: HTMLElement) {
      button.click()
      await settle()
    },
    restore() {
      performance.now = real.now
      globalThis.setTimeout = real.setTimeout
      globalThis.clearTimeout = real.clearTimeout
    },
  }
}
