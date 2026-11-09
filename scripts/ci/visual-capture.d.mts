// Types of visual-capture.mjs for the TypeScript callers.

export function shootUntilSteady(
  shoot: () => Promise<Buffer>,
  pause: () => Promise<void>,
): Promise<{ steady: boolean; png: Buffer }>

export function runInContainer(
  script: string,
  args: readonly string[],
  out: string,
  files?: Readonly<Record<string, string>>,
): Promise<void>
