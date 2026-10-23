// The text patterns of the host patch validator (ADR-052 section 5). The
// validator (apps/backend/src/domain/ingestion/patch-validator.ts) imports
// them from here, so that a script skill can apply the same rules before it
// writes a file. Change them here only.

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
