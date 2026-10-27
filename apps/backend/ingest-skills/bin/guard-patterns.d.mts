// Types for guard-patterns.mjs. The UI type check reads patch-validator.ts,
// which imports that module, and the UI does not allow JavaScript.
export declare const WORKFLOW_FILE_PATTERN: RegExp
export declare const DENIED_HEADINGS: readonly RegExp[]
export declare const INJECTION_PHRASES: readonly RegExp[]
export declare function hasInstruction(text: string): boolean
export declare function hasInstructionIn(
  text: string,
  options?: { everywhere?: boolean; inlineCode?: boolean },
): boolean
export declare function fileHasInstruction(yaml: string, body: string): boolean
export declare function fileHasInstructionWithoutSource(
  yaml: string,
  body: string,
): boolean
export declare function withoutCode(text: string, keepSpanText: boolean): string
export declare function codeSpans(
  line: string,
): Array<{ start: number; end: number; text: string }>
