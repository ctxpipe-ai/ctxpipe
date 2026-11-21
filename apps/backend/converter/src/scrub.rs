//! `ctxpipe-convert --scrub`: removes secrets from the text that goes to a
//! model (ADR-072). The process stays alive. Each line on stdin is one
//! request, `{"id": N, "texts": [...]}`. Each line on stdout is its answer,
//! in the same order and with the same id: `{"id": N, "texts": [...]}` with
//! the scrubbed strings in the same order, or `{"id": N, "error": "..."}`.
//! A line that is not a request gets `{"id": null, "error": "..."}`. The
//! caller checks the id, so an answer never goes to another request.
//!
//! Kingfisher (MongoDB, Apache-2.0) finds the secrets with its built-in rules
//! (medium confidence and higher) and one rule of ours, for the password of a
//! URL (`url-credentials`). Detection only: no rule sends a found
//! secret to its provider. Each found secret becomes `[REDACTED:<rule id>]`.
//! The same input gives the same output: the scan keeps no state between
//! requests, and the order of the replacements is fixed.

use std::io::{BufRead, Read, Write};
use std::sync::Arc;

use kingfisher_rules::RuleCacheConfig;
use kingfisher_scanner::{RuleSyntax, RulesDatabase, Scanner, ScannerConfig, get_builtin_rules};
use serde_json::{Value, json};

/// One request line: its id and its texts.
fn request(line: &[u8]) -> Result<(u64, Vec<String>), String> {
    let mut value: Value = serde_json::from_slice(line).map_err(|error| error.to_string())?;
    let id = value["id"].as_u64().ok_or("The request has no id.")?;
    let texts = serde_json::from_value(value["texts"].take()).map_err(|error| error.to_string())?;
    Ok((id, texts))
}

/// The id of our one rule beside the rules of Kingfisher (`serve`).
const URL_CREDENTIALS: &str = "url-credentials";

/// The bytes of a match of `url-credentials` that are a password, or None
/// for a match that holds no password:
/// - a template (`${DB_PASSWORD}`, `$DB_PASSWORD`, `%(password)s`,
///   `%PASSWORD%`, `{password}`, `{{password}}`, `<password>`, only `*`). A real password
///   that only starts with one of these characters (`%21abc`, `$uperSecret`,
///   `*abc123`) is not a template;
/// - a port and a query or a fragment, of a URL with no credentials
///   (`https://host:8443?email=a@b`).
///
/// A match runs to the last `@` of its URL. When a host, a port and then a
/// query or a fragment follow an earlier `@` (`pw@cache:6379?x=a@b`), the
/// password ends at that `@`. Else the `@` is a part of the password
/// (`p@ss:12345678`).
fn url_password_len(matched: &str) -> Option<usize> {
    let is_identifier = |text: &str| {
        let mut chars = text.chars();
        matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
    };
    let wrapped_in = |open: &str, close: &str| {
        matched.len() > open.len() + close.len()
            && matched.starts_with(open)
            && matched.ends_with(close)
    };
    let is_template = matched.chars().all(|c| c == '*')
        || wrapped_in("{", "}")
        || wrapped_in("<", ">")
        || wrapped_in("${", "}")
        || wrapped_in("%(", ")s")
        || (wrapped_in("%", "%") && is_identifier(&matched[1..matched.len() - 1]))
        || matched.strip_prefix('$').is_some_and(|name| {
            is_identifier(name) && !name.chars().any(|c| c.is_ascii_lowercase())
        });
    let digits = matched.bytes().take_while(u8::is_ascii_digit).count();
    let is_port_and_query =
        digits > 0 && matches!(matched.as_bytes().get(digits), Some(b'?' | b'#'));
    if is_template || is_port_and_query {
        return None;
    }
    // The first `@` after which a host, a port and a query or a fragment
    // come (`@cache:6379?`).
    let host_and_port = matched.match_indices('@').find(|(at, _)| {
        let rest = &matched[at + 1..];
        rest.split_once(':').is_some_and(|(host, after)| {
            let port = after.bytes().take_while(u8::is_ascii_digit).count();
            !host.is_empty()
                && !host.contains(['@', '?', '#'])
                && port > 0
                && matches!(after.as_bytes().get(port), Some(b'?' | b'#'))
        })
    });
    Some(host_and_port.map_or(matched.len(), |(at, _)| at))
}

/// The largest request line: more than the largest model request.
const MAX_LINE_BYTES: u64 = 64 * 1024 * 1024;

/// Compile the rules, close the sandbox, then answer requests until stdin
/// closes. The compiled rules (vectorscan bytecode, about 3 s to compile) go
/// to `rule_cache`, so that the next start loads them in about 0.3 s.
/// Kingfisher uses the cache only when this user owns the folder and no other
/// user can write to it or to a folder above it; else it compiles again.
pub fn serve(
    rule_cache: Option<String>,
    sandbox: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let mut rules = get_builtin_rules(None).map_err(|error| error.to_string())?;
    // Our one rule: Kingfisher's rules do not find the password of a plain
    // URL, `scheme://user:password@host` of any scheme. The user can be
    // empty (`redis://:password@host`) or an email address. The password
    // runs to the last `@` before the host, so it can hold `@`, `%`, `?`,
    // `#` and `'` (each valid in the userinfo of a URI). The scheme, the user
    // and the password have no length limit. The host can be any text: a
    // template (`@${DB_HOST}`), a name that starts with `_`, or empty for a
    // Unix socket (`@/db?host=/var/run/postgresql`). The unnamed capture is
    // the password, so only it becomes `[REDACTED:url-credentials]`. A user
    // with no password (`user@host`) does not match, and `scrub` keeps only
    // the bytes that are a password (`url_password_len`). Known gap: a
    // password with an unencoded `/` does not match, because a `/` also
    // starts the path of a URL with no credentials.
    rules.rules.insert(
        URL_CREDENTIALS.into(),
        RuleSyntax::new(
            URL_CREDENTIALS,
            "Credentials in a URL",
            r#"(?i)\b[a-z][a-z0-9+.\-]*://[^\s:/?#"<>]*:([^\s/"<>]+)@[^\s"<>]"#,
        ),
    );
    let database = RulesDatabase::from_rule_collection_with_cache(
        rules,
        &RuleCacheConfig::new(rule_cache.unwrap_or_default()),
    )
    .map_err(|error| error.to_string())?;
    let scanner = Scanner::with_config(
        Arc::new(database),
        // No dedup: each occurrence of a secret is a finding, and a request
        // does not depend on the requests before it.
        ScannerConfig {
            enable_dedup: false,
            ..Default::default()
        },
    );
    sandbox()?;
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = (&mut input)
            .take(MAX_LINE_BYTES + 1)
            .read_until(b'\n', &mut line)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Ok(());
        }
        let answer = if line.len() as u64 > MAX_LINE_BYTES {
            // The rest of the line is not a request: stop.
            return Err("A request is larger than 64 MiB.".into());
        } else {
            match request(&line) {
                Ok((id, texts)) => texts
                    .iter()
                    .map(|text| scrub(&scanner, text))
                    .collect::<Result<Vec<_>, _>>()
                    .map(|texts| json!({ "id": id, "texts": texts }))
                    .unwrap_or_else(|error| json!({ "id": id, "error": error })),
                Err(error) => json!({ "id": null, "error": error }),
            }
        };
        writeln!(output, "{answer}").map_err(|error| error.to_string())?;
        output.flush().map_err(|error| error.to_string())?;
    }
}

/// The text with each secret that a visible rule finds replaced by
/// `[REDACTED:<rule id>]`. Overlapping findings become one replacement that
/// covers all of them, with the rule id of the first finding.
pub fn scrub(scanner: &Scanner, text: &str) -> Result<String, String> {
    let findings = scanner
        .scan_bytes(text.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut spans: Vec<(usize, usize, String)> = findings
        .into_iter()
        .filter(|finding| finding.rule().visible())
        .filter_map(|finding| {
            let start = finding.location.start_offset;
            let end = finding.location.end_offset.min(text.len());
            if finding.rule_id != URL_CREDENTIALS {
                return Some((start, end, finding.rule_id));
            }
            // Our URL rule: only the bytes that are a password.
            let len = url_password_len(text.get(start..end)?)?;
            Some((start, start + len, finding.rule_id))
        })
        .filter(|(start, end, _)| start < end)
        .collect();
    // Fixed order: by start, then the longest first, then by rule id.
    spans.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)).then(a.2.cmp(&b.2)));
    let mut merged: Vec<(usize, usize, String)> = Vec::new();
    for (start, end, rule) in spans {
        match merged.last_mut() {
            Some(last) if start < last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end, rule)),
        }
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    for (start, end, rule) in merged {
        // A span on a byte that is not the start of a character grows to
        // cover all of that character.
        let start = text.floor_char_boundary(start).max(at);
        let end = text.ceil_char_boundary(end);
        out.extend_from_slice(&bytes[at..start]);
        out.extend_from_slice(format!("[REDACTED:{rule}]").as_bytes());
        at = end;
    }
    out.extend_from_slice(&bytes[at..]);
    String::from_utf8(out).map_err(|error| error.to_string())
}
