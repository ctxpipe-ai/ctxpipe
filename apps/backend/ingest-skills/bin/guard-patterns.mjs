// The text patterns of the host patch validator (ADR-052 section 5). The
// validator (apps/backend/src/domain/ingestion/patch-validator.ts) imports
// them, and the scan functions below, from here, so that a script skill can
// apply the same rules before it writes a file. Change them here only.

/**
 * A GitHub Actions workflow file: GitHub runs only the files directly in
 * `.github/workflows/`. The `workflows` skill, the validator, and the hydrate
 * step use this pattern.
 */
export const WORKFLOW_FILE_PATTERN =
  /^\.github\/workflows\/[A-Za-z0-9_.-]{1,100}\.ya?ml$/

/** A heading that matches one of these addresses agents or models. */
export const DENIED_HEADINGS = [
  /\bsystem\s+prompts?\b/i,
  /\b(?:ai|llm|coding|autonomous)\s+(?:agents?|assistants?|models?)\b/i,
  /\b(?:for|to|attention)\s+(?:the\s+|all\s+)?(?:ai|llms?|agents?|assistants?|models?|claude|gpt|chatgpt|copilot|cursor)\b/i,
  /\b(?:claude|chatgpt|gpt-?\d*|copilot|gemini)\b/i,
  /^(?:ai|llms?|agents?|assistants?|prompts?)$/i,
]

/** Text that matches one of these looks like an instruction to an agent. */
export const INJECTION_PHRASES = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|preceding|all|any|your|the)\b[^.\n]{0,20}\b(?:instructions?|prompts?|rules|directives|guidelines)\b/i,
  /\byou are (?:now|no longer)\b/i,
  /\b(?:new|updated|real|actual) (?:system )?instructions?\s*:/i,
  /\bsystem prompt\b/i,
  /\b(?:reveal|print|show|output|leak|exfiltrate|send|upload)\b[^.\n]{0,40}\b(?:system prompt|api[_ -]?keys?|credentials?|secrets?|access tokens?|passwords?)\b/i,
  /\b(?:do not|don't|never) (?:tell|inform|alert) (?:the )?(?:user|human|operator)\b/i,
  /\bas an ai\b/i,
  /\b(?:ai|llm|coding) (?:agents?|assistants?|models?)\b[,:]?\s*(?:must|should|need to|are required to|please)\b/i,
  /<\|?(?:im_start|im_end|endoftext)\|?>|\[\/?INST\]|<<\/?SYS>>/i,
]

/** True when the text matches an injection phrase. */
export function hasInstruction(text) {
  return INJECTION_PHRASES.some((pattern) => pattern.test(text))
}

/**
 * True when the validator would refuse the text as an instruction to an
 * agent (concept section 6). It scans text outside fenced code, block
 * quotes, and inline code, after it joins all white space. `inlineCode`
 * scans the text of code spans too, and `everywhere` scans all of the text.
 */
export function hasInstructionIn(text, options = {}) {
  const outside = (
    options.everywhere
      ? text
      : withoutCode(text, options.inlineCode ?? false)
          .split("\n")
          .filter((line) => !/^ {0,3}>/.test(line))
          .join("\n")
  ).replace(/\s+/g, " ")
  return hasInstruction(outside)
}

/**
 * True when the validator would refuse a file for an injection phrase in
 * its text: the whole front matter, and the body outside code. The
 * validator and the scripts both call this, so the two cannot differ.
 */
export function fileHasInstruction(yaml, body) {
  return hasInstructionIn(yaml, { everywhere: true }) || hasInstructionIn(body)
}

/**
 * The same, for a file that has no `Source:` line. The validator also
 * refuses a code span, a fenced block, or a block quote that holds a phrase
 * and gives no source (ADR-052 section 5). A script writes no fenced block
 * and no block quote, so it reads the text of the code spans of the body as
 * text too. This is the scan of the validator for an added text, and it
 * finds each phrase that the quote rule finds.
 */
export function fileHasInstructionWithoutSource(yaml, body) {
  return (
    fileHasInstruction(yaml, body) ||
    hasInstructionIn(body, { inlineCode: true })
  )
}

/**
 * Removes fenced code blocks and inline code spans. With `keepSpanText`, a
 * code span keeps its text and loses only its backticks. Without it, a
 * span becomes one space, so the words at its two sides stay apart.
 */
export function withoutCode(text, keepSpanText) {
  const out = []
  let fence = null
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        line.trim() === marker
      )
        fence = null
      out.push("")
      continue
    }
    if (marker) {
      fence = marker
      out.push("")
      continue
    }
    let kept = ""
    let at = 0
    for (const span of codeSpans(line)) {
      kept += line.slice(at, span.start) + (keepSpanText ? span.text : " ")
      at = span.end
    }
    out.push(kept + line.slice(at))
  }
  return out.join("\n")
}

/**
 * The code spans of one line, in linear time: a run of n backticks opens a
 * span that the next run of exactly n backticks closes.
 */
export function codeSpans(line) {
  const runs = []
  for (let i = line.indexOf("`"); i !== -1; i = line.indexOf("`", i)) {
    let j = i
    while (line[j] === "`") j++
    runs.push({ at: i, length: j - i })
    i = j
  }
  const next = []
  const later = new Map()
  for (let k = runs.length - 1; k >= 0; k--) {
    const length = runs[k]?.length ?? 0
    next[k] = later.get(length) ?? -1
    later.set(length, k)
  }
  const spans = []
  for (let k = 0; k < runs.length;) {
    const open = runs[k]
    const close = runs[next[k] ?? -1]
    if (!open || !close) {
      k++
      continue
    }
    spans.push({
      start: open.at,
      end: close.at + close.length,
      text: line.slice(open.at + open.length, close.at),
    })
    k = (next[k] ?? k) + 1
  }
  return spans
}
