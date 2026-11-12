// Types of visual-capture.mjs for the TypeScript callers.

export const viewports: {
  desktop: { width: 1440; height: 900 }
  mobile: { width: 390; height: 844 }
}

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
