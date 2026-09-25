declare const Bun: {
  RedisClient: new (url: string) => {
    send: (command: string, args: string[]) => Promise<unknown>
    close: () => void
  }
}

declare const process: {
  env: Record<string, string | undefined>
  exit: (code: number) => never
}

interface ImportMeta {
  readonly main: boolean
}

interface BunExpect {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
  toBeNull(): void
  toBeUndefined(): void
  toHaveLength(expected: number): void
  toContain(expected: unknown): void
  toContainEqual(expected: unknown): void
  toMatchObject(expected: object): void
}

declare module "bun:test" {
  export function describe(name: string, fn: () => void): void
  export function test(name: string, fn: () => void | Promise<void>): void
  export function expect(value: unknown): BunExpect
}
