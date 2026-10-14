/**
 * The secret-value scan of the patch validator (ADR-052 section 5). The
 * source repository is hostile, so the scan also reads the text in other
 * forms: with Markdown escapes removed, with line breaks inside a token
 * removed, and with base64 and percent-escaped runs decoded.
 *
 * Cost: each form is at most as long as the text, each line is read a fixed
 * number of times, and each regular expression has bounded quantifiers.
 * `meter.work` counts the characters that the scan reads, so a test can
 * check the bound without a clock.
 */

export type SecretFinding = { line: number; reason: string }
export type WorkMeter = { work: number }

const HUMAN_OPEN = "<!-- ctxpipe:human -->"
const HUMAN_CLOSE = "<!-- /ctxpipe:human -->"

/** Token shapes; the name goes into the reason, never the value. */
const SECRET_TOKENS: ReadonlyArray<[string, RegExp]> = [
  ["GitHub token", /^(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{40,})$/],
  ["AWS access key id", /^(?:AKIA|ASIA)[A-Z0-9]{16}$/],
  ["Slack token", /^xox[abprs]-(?=[\w-]*\d)[\w-]{10,}$/],
  ["Stripe key", /^[rs]k_live_[A-Za-z0-9]{16,}$/],
  ["API key", /^sk-(?=[\w-]*\d)[\w-]{32,}$/],
  ["Google API key", /^AIza[\w-]{35}$/],
  ["npm token", /^npm_[A-Za-z0-9]{36}$/],
  ["GitLab token", /^glpat-[\w-]{20,}$/],
]
const TOKEN_WORD = /[A-Za-z0-9_-]{16,}/g
const JWT = /^eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}$/
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/
/**
 * A DER private key in base64 without its BEGIN line: an RSA key (PKCS#1 or
 * PKCS#8, version 0 after the sequence header), a SEC1 EC key, or a PKCS#8
 * Ed25519 key. A certificate or a public key has another header.
 */
const PRIVATE_KEY_BODY =
  /^(?:MII[A-Za-z0-9+/]{2}AIBA[AD][A-Za-z0-9+/]{400}|MHcCAQEE[A-Za-z0-9+/]{100}|MC4CAQAwBQYDK2Vw[A-Za-z0-9+/]{20})/
const AUTH_HEADER =
  /\bAuthorization["']?[ \t]*[:=][ \t]*["']?(?:Bearer|Basic|token|Token)[ \t]+([^\s"'`]{1,512})/i
/**
 * A key and its value, anywhere in a line: `.env`, shell, YAML, TOML, JSON,
 * `.npmrc`, and `;`-separated connection strings.
 */
const ASSIGNMENT =
  /(?<![\w.-])["']?([A-Za-z_][\w.-]{0,99})["']?[ \t]*[:=][ \t]*([|>][-+0-9]{0,3}[ \t]*$|"[^"\n]{0,256}"|'[^'\n]{0,256}'|[^\s"'`|,;]{1,512})/g
/** A name whose value is a secret, also with a number suffix (`API_KEY_1`). */
const STRONG_NAME =
  /(?:secret|token|passw(?:or)?d|pwd|credentials?|auth|api[_-]?key|access[_-]?key|private[_-]?key|account[_-]?key|signing[_-]?key|master[_-]?key|encryption[_-]?key|secret[_-]?key[_-]?base|key[_-]?base)(?:[_-]?\d{1,3})?$|^(?:pass|pwd)$/i
/** A name that is often not secret (`cache_key`): only a random-looking value counts. */
const WEAK_NAME = /key(?:[_-]?\d{1,3})?$/i
/** A placeholder is the whole value, never a part of it. */
const PLACEHOLDER =
  /^(?:<[^>]*>|\$\{[^}]*\}|\$\(.*\)|\$[A-Za-z_]\w*|\{\{.*\}\}|%[A-Za-z_]\w*%|change[-_]?me|(?:your|my)[-_].*|redacted|placeholder|dummy|sample|example|todo|tbd|none|null|nil|true|false|undefined|password|secret|[A-Za-z]{0,12}[-_]?(?:x{4,}|X{4,}|\*{3,}|\.{3,}|0{6,}))$/i
const COMMON_PASSWORDS = new Set([
  "password",
  "passwd",
  "pass",
  "secret",
  "postgres",
  "root",
  "admin",
  "test",
  "user",
])

/**
 * Finds a value that looks like a credential. Human sections stay as they
 * are, so the scan does not read them.
 */
export function findSuspectedSecret(
  text: string,
  meter: WorkMeter = { work: 0 },
): SecretFinding | null {
  const plain = withoutHumanText(text, meter)
  const forms: Array<[string, string, (line: number) => number]> = [
    ["", plain, (line) => line],
  ]
  if (plain.includes("\\")) {
    meter.work += plain.length
    forms.push(["", plain.replace(/\\([!-/:-@[-`{-~])/g, "$1"), (line) => line])
  }
  const joined = joinTokenLines(plain, meter)
  if (joined) forms.push(["joined ", joined.text, joined.line])
  for (const [label, form, lineOf] of forms) {
    const found = scanLines(form, meter)
    if (found) return finding(lineOf(found.line), found.rule, label)
  }
  for (const decoded of decodedRuns(plain, meter)) {
    const found = scanLines(decoded.text, meter)
    if (found) return finding(decoded.line, found.rule, "decoded ")
  }
  return null
}

function finding(line: number, rule: string, form: string): SecretFinding {
  return {
    line,
    reason: `The ${form}text has a value that looks like a secret (${rule}) on line ${line}`,
  }
}

/** Each line of a human section becomes empty, in one pass; line numbers stay. */
export function withoutHumanText(text: string, meter: WorkMeter): string {
  meter.work += text.length
  let out = ""
  let at = 0
  for (;;) {
    const open = text.indexOf(HUMAN_OPEN, at)
    if (open === -1) break
    const close = text.indexOf(HUMAN_CLOSE, open + HUMAN_OPEN.length)
    if (close === -1) break
    const end = close + HUMAN_CLOSE.length
    out += text.slice(at, open)
    for (let i = open; i < end; i++) if (text.charCodeAt(i) === 10) out += "\n"
    at = end
  }
  return out + text.slice(at)
}

const TOKEN_CHAR = /[A-Za-z0-9_+/=-]/

/**
 * The text with each line break inside a token-shaped run removed, so a
 * token that is cut over lines is whole again. A YAML `\` at the line end
 * and the indent or quote marker of the next line go too. Null when no line
 * joins.
 */
function joinTokenLines(
  text: string,
  meter: WorkMeter,
): { text: string; line: (line: number) => number } | null {
  meter.work += text.length
  const lines = text.split("\n")
  const out: string[] = []
  const starts: number[] = []
  let joinedAny = false
  for (const [index, raw] of lines.entries()) {
    const previous = out.length ? (out[out.length - 1] ?? "") : null
    const rest = raw.replace(/^[ \t>]{0,40}/, "")
    if (previous !== null) {
      const tail = previous.endsWith("\\") ? previous.slice(0, -1) : previous
      if (
        TOKEN_CHAR.test(tail.at(-1) ?? "") &&
        TOKEN_CHAR.test(rest[0] ?? "") &&
        /[A-Za-z0-9_+/=-]{8}$/.test(tail.slice(-8))
      ) {
        out[out.length - 1] = tail + rest
        joinedAny = true
        continue
      }
    }
    out.push(raw)
    starts.push(index + 1)
  }
  if (!joinedAny) return null
  return { text: out.join("\n"), line: (line) => starts[line - 1] ?? line }
}

const BASE64_RUN = /[A-Za-z0-9+/_-]{16,4096}={0,2}/g
const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2}|[A-Za-z0-9_.~+:@/=-]){8,4096}/g

/** Decoded base64 and percent-escaped runs that are printable text. */
function* decodedRuns(
  text: string,
  meter: WorkMeter,
): Generator<{ text: string; line: number }> {
  let line = 1
  let counted = 0
  const lineAt = (index: number) => {
    for (; counted < index; counted++)
      if (text.charCodeAt(counted) === 10) line++
    return line
  }
  meter.work += text.length
  for (const match of text.matchAll(BASE64_RUN)) {
    const run = match[0]
    meter.work += run.length
    const decoded = Buffer.from(run, "base64").toString("latin1")
    if (/^[\t\n\r\x20-\x7e]{12,}$/.test(decoded))
      yield { text: decoded, line: lineAt(match.index ?? 0) }
  }
  line = 1
  counted = 0
  meter.work += text.length
  for (const match of text.matchAll(PERCENT_RUN)) {
    const run = match[0]
    if (!run.includes("%")) continue
    meter.work += run.length
    try {
      yield {
        text: decodeURIComponent(run),
        line: lineAt(match.index ?? 0),
      }
    } catch {
      // Not valid percent-escapes: the run is plain text, already scanned.
    }
  }
}

function scanLines(
  text: string,
  meter: WorkMeter,
): { line: number; rule: string } | null {
  const lines = text.split("\n")
  for (const [index, line] of lines.entries()) {
    const number = index + 1
    const hit = (rule: string) => ({ line: number, rule })
    meter.work += line.length

    if (line.includes("-----BEGIN ") && PRIVATE_KEY.test(line))
      return hit("private key")
    const trimmed = line.trim()
    if (PRIVATE_KEY_BODY.test(trimmed)) return hit("private key")

    meter.work += line.length
    if (urlPassword(line)) return hit("password in a connection string")

    meter.work += line.length
    const header = AUTH_HEADER.exec(line)?.[1]
    if (header && secretValue(header, "strong"))
      return hit("authorization header")

    meter.work += line.length
    for (const match of line.matchAll(ASSIGNMENT)) {
      const name = match[1] ?? ""
      let value = unquote(match[2] ?? "")
      if (/^[|>][-+0-9]{0,3}[ \t]*$/.test(value))
        value = blockScalar(lines, index)
      const strength = nameStrength(name)
      if (strength && secretValue(value, strength))
        return hit("secret assignment")
    }

    if (trimmed.startsWith("|")) {
      meter.work += line.length
      const cells = trimmed
        .split("|")
        .map((c) => c.trim().replace(/^`|`$/g, ""))
      for (let i = 0; i + 1 < cells.length; i++) {
        const strength = /^[A-Za-z_][\w.-]{0,99}$/.test(cells[i] ?? "")
          ? nameStrength(cells[i] ?? "")
          : null
        if (strength && secretValue(cells[i + 1] ?? "", strength))
          return hit("secret in a table")
      }
    }

    meter.work += line.length
    if (line.includes("eyJ"))
      for (const match of line.matchAll(/[\w.-]+/g)) {
        const at = match[0].indexOf("eyJ")
        if (at !== -1 && JWT.test(match[0].slice(at).replace(/\.+$/, "")))
          return hit("JWT")
      }
    for (const match of line.matchAll(TOKEN_WORD)) {
      const word = match[0]
      if (PLACEHOLDER.test(word)) continue
      const shape = SECRET_TOKENS.find(([, pattern]) => pattern.test(word))
      if (shape) return hit(shape[0])
    }
  }
  return null
}

/** The value of a YAML block scalar: the next lines, while they are indented. */
function blockScalar(lines: string[], index: number): string {
  const parts: string[] = []
  for (let i = index + 1; i < lines.length && i <= index + 4; i++) {
    const next = lines[i] ?? ""
    if (!/^[ \t]/.test(next)) break
    parts.push(next.trim())
  }
  return parts.join("")
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value)
  if (quoted) return quoted[2] ?? ""
  // A bare value can end a sentence or a flow map: `{key: value}.`
  const bare = value.replace(/[.)\]]+$/, "")
  return bare.includes("{") ? bare : bare.replace(/\}+$/, "")
}

function nameStrength(name: string): "strong" | "weak" | null {
  if (STRONG_NAME.test(name)) return "strong"
  if (WEAK_NAME.test(name)) return "weak"
  return null
}

/**
 * A value is a secret when it has no space, is not a placeholder or a code
 * reference, and is long and mixed enough. A `strong` name (`*_TOKEN`)
 * needs 8 characters of two character classes, or 16 characters. A `weak`
 * name (`cache_key`) needs a random-looking value of 16 characters.
 */
function secretValue(value: string, strength: "strong" | "weak"): boolean {
  if (value.length < 8 || /\s/.test(value) || PLACEHOLDER.test(value))
    return false
  if (COMMON_PASSWORDS.has(value.toLowerCase())) return false
  // A dotted name or a call is a reference to the value: process.env.API_KEY.
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(.*\))?$/.test(value))
    return false
  if (/^[A-Za-z_$][\w$.]*\(.*\)$/.test(value)) return false
  const classes =
    Number(/[a-z]/.test(value)) +
    Number(/[A-Z]/.test(value)) +
    Number(/\d/.test(value)) +
    Number(/[^\w.-]/.test(value))
  if (strength === "strong") return classes >= 2 || value.length >= 16
  // Words with separators, such as node-modules-v2, are names, not keys.
  if (/^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/.test(value)) return false
  return value.length >= 16 && classes >= 2 && entropy(value) >= 3.5
}

/** Shannon entropy in bits per character. */
function entropy(value: string): number {
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const p = count / value.length
    bits -= p * Math.log2(p)
  }
  return bits
}

/**
 * A password in `scheme://user:password@host`. The password may hold `@`
 * and `/`: it ends at the last `@` before the next space. Each scan stops at
 * the next `://`, so the scans do not overlap.
 */
function urlPassword(line: string): boolean {
  for (let at = line.indexOf("://"); at !== -1; ) {
    const next = line.indexOf("://", at + 3)
    let end = next === -1 ? line.length : next
    const space = line.slice(at + 3, end).search(/[\s"'`<>)\]]/)
    if (space !== -1) end = at + 3 + space
    const authority = line.slice(at + 3, end)
    at = next
    const colon = authority.indexOf(":")
    const lastAt = authority.lastIndexOf("@")
    if (colon <= 0 || lastAt <= colon + 1) continue
    const user = authority.slice(0, colon)
    if (/[/?#]/.test(user)) continue
    // host:port/path@x is not a password.
    if (/^\d{1,5}(?:[/?#]|$)/.test(authority.slice(colon + 1))) continue
    if (!/^[\w.-]/.test(authority.slice(lastAt + 1))) continue
    const password = authority.slice(colon + 1, lastAt)
    if (
      password !== user &&
      password.length >= 6 &&
      !COMMON_PASSWORDS.has(password.toLowerCase()) &&
      !PLACEHOLDER.test(password)
    )
      return true
  }
  return false
}
