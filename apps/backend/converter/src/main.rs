//! ctxpipe-convert: converts one file to text for the knowledge plane
//! (ADR-066 decision 6, ADR-067). The file comes on stdin and the result goes
//! to stdout as one JSON object. The same bytes give the same output.
//!
//!   ctxpipe-convert --format <pdf|docx|pptx|xlsx|html|svg>
//!                   --max-memory-mb N --max-cpu-seconds N
//!   ctxpipe-convert --version
//!
//! The input is untrusted. The process sets its own memory and CPU limits
//! before it reads the input, and each parser has size limits. The caller
//! also applies a wall-clock limit and a cap on the output, and runs the
//! process as an unprivileged user with no environment. On Linux, after it
//! reads the input, the process installs a seccomp filter that refuses each
//! system call that opens a file, makes a socket or starts a program
//! (`sandbox`). An SVG cannot load an external image, and the only font is
//! the embedded DejaVu Sans.

use std::io::{Read, Write};
use std::process::ExitCode;

use base64::Engine;
use serde_json::{Value, json};

/// The version line of `--version`: the package version and the hash that
/// build.rs makes of Cargo.lock, the source, the font and the Rust compiler.
/// It is part of the projection version (ADR-067).
const VERSION: &str = concat!(
    "ctxpipe-convert ",
    env!("CARGO_PKG_VERSION"),
    " ",
    env!("CONVERTER_HASH")
);

/// The largest input. The caller refuses a larger file before it starts the
/// process; this check also stops a caller that does not.
const MAX_INPUT_BYTES: u64 = 64 * 1024 * 1024;
/// The largest text of one file.
const MAX_TEXT_BYTES: usize = 16 * 1024 * 1024;
/// The most PDF pages. A PDF with more pages fails as `too-many-pages`, and
/// the extraction reads only this many pages first.
const MAX_PDF_PAGES: u32 = 2_000;
/// The longest side of the PNG of an SVG, in pixels.
const MAX_SVG_SIDE: f32 = 2_048.0;
/// The most nodes of an SVG.
const MAX_SVG_NODES: usize = 200_000;

/// A typed failure. The caller records it on a `failed` document.
struct Failure {
    kind: &'static str,
    message: String,
}

fn fail(kind: &'static str, message: impl Into<String>) -> Failure {
    Failure {
        kind,
        message: message.into(),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--version") {
        println!("{VERSION}");
        return ExitCode::SUCCESS;
    }
    let value = |name: &str| {
        args.iter()
            .position(|arg| arg == name)
            .and_then(|at| args.get(at + 1))
            .cloned()
    };
    let number = |name: &str| value(name).and_then(|text| text.parse::<u64>().ok());
    // The caller sets the limits, in one place.
    let (Some(memory_mb), Some(cpu_seconds)) =
        (number("--max-memory-mb"), number("--max-cpu-seconds"))
    else {
        eprintln!("Give --max-memory-mb and --max-cpu-seconds.");
        return ExitCode::FAILURE;
    };
    set_limits(memory_mb, cpu_seconds);
    let result = value("--format")
        .ok_or_else(|| fail("usage", "Give --format."))
        .and_then(|format| {
            let mut bytes = Vec::new();
            std::io::stdin()
                .take(MAX_INPUT_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| fail("io", error.to_string()))?;
            if bytes.len() as u64 > MAX_INPUT_BYTES {
                return Err(fail("too-large", "The file is larger than 64 MiB."));
            }
            sandbox().map_err(|error| fail("sandbox", error))?;
            convert(&format, &bytes)
        });
    let output = match result {
        Ok(mut value) => {
            value["ok"] = json!(true);
            value
        }
        Err(failure) => json!({ "ok": false, "failure": failure.kind, "message": failure.message }),
    };
    let mut stdout = std::io::stdout().lock();
    if writeln!(stdout, "{output}").is_err() {
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

/// The address-space and CPU limits of this process. They hold for each
/// parser and cannot be lifted by the input. macOS does not apply an
/// address-space limit, so there the caller's limits do the work.
fn set_limits(memory_mb: u64, cpu_seconds: u64) {
    #[cfg(unix)]
    unsafe {
        let memory = libc::rlimit {
            rlim_cur: memory_mb * 1024 * 1024,
            rlim_max: memory_mb * 1024 * 1024,
        };
        libc::setrlimit(libc::RLIMIT_AS, &memory);
        let cpu = libc::rlimit {
            rlim_cur: cpu_seconds,
            rlim_max: cpu_seconds,
        };
        libc::setrlimit(libc::RLIMIT_CPU, &cpu);
    }
}

/// The seccomp filters of the conversion (Linux). After the input is read,
/// only the calls that the parsers need work: memory, threads, time,
/// signals of this process, random bytes, and the read and write of the
/// open stdin and stdout. Each other call fails with EPERM: a file, a
/// change of a path, a socket, a program, a process, shared memory or a
/// message queue (they outlive the process), and another process. The set
/// comes from a trace of the conversion of each test file (`strace`), with
/// musl (the worker image) and with glibc (a Linux host of the tests).
///
/// - `clone` works only with `CLONE_THREAD`: a parser can use threads, but
///   no process.
/// - `prlimit64` works only on this process (pid 0): all converters run as
///   `nobody`, so another pid can be the converter of another organization.
/// - `clone3` fails with ENOSYS, so that the C library uses `clone`, whose
///   flags the filter can read. A first filter gives the ENOSYS; the
///   allowlist lets `clone3` through to it, because the kernel takes the
///   errno of the newest filter that refuses a call.
///
/// The threads that a parser starts later get the same filters.
#[cfg(target_os = "linux")]
fn sandbox() -> Result<(), String> {
    use seccompiler::{
        BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
        SeccompRule,
    };
    let arch = std::env::consts::ARCH
        .try_into()
        .map_err(|_| "no seccomp target for this arch".to_string())?;
    let program = |rules, mismatch, matched| -> Result<BpfProgram, String> {
        SeccompFilter::new(rules, mismatch, matched, arch)
            .map_err(|error| error.to_string())?
            .try_into()
            .map_err(|error: seccompiler::BackendError| error.to_string())
    };
    let clone3 = [(libc::SYS_clone3, vec![])].into_iter().collect();
    seccompiler::apply_filter(&program(
        clone3,
        SeccompAction::Allow,
        SeccompAction::Errno(libc::ENOSYS as u32),
    )?)
    .map_err(|error| error.to_string())?;

    let condition = |arg, op, value| {
        SeccompCondition::new(arg, SeccompCmpArgLen::Qword, op, value)
            .and_then(|condition| SeccompRule::new(vec![condition]))
            .map_err(|error| error.to_string())
    };
    // x86_64 adds `nanosleep`, which arm64 does not have.
    #[cfg_attr(not(target_arch = "x86_64"), allow(unused_mut))]
    let mut allowed = vec![
        // stdin, stdout and stderr, which are open.
        libc::SYS_read,
        libc::SYS_write,
        libc::SYS_writev,
        libc::SYS_close,
        // Memory.
        libc::SYS_brk,
        libc::SYS_mmap,
        libc::SYS_munmap,
        libc::SYS_mremap,
        libc::SYS_mprotect,
        libc::SYS_madvise,
        // Threads and their locks.
        libc::SYS_futex,
        libc::SYS_sched_yield,
        libc::SYS_sched_getaffinity,
        libc::SYS_gettid,
        libc::SYS_getpid,
        libc::SYS_set_robust_list,
        // glibc registers each new thread for restartable sequences, and
        // stops the process when the call fails. It acts on that thread only.
        libc::SYS_rseq,
        libc::SYS_exit,
        libc::SYS_exit_group,
        // The signals of this process (a panic or an abort).
        libc::SYS_rt_sigaction,
        libc::SYS_rt_sigprocmask,
        libc::SYS_rt_sigreturn,
        libc::SYS_sigaltstack,
        // Time and random bytes.
        libc::SYS_clock_gettime,
        libc::SYS_clock_nanosleep,
        libc::SYS_getrandom,
        libc::SYS_clone3,
    ];
    #[cfg(target_arch = "x86_64")]
    allowed.push(libc::SYS_nanosleep);
    let mut rules: std::collections::BTreeMap<i64, Vec<SeccompRule>> =
        allowed.into_iter().map(|call| (call, vec![])).collect();
    rules.insert(
        libc::SYS_clone,
        vec![condition(
            0,
            SeccompCmpOp::MaskedEq(libc::CLONE_THREAD as u64),
            libc::CLONE_THREAD as u64,
        )?],
    );
    rules.insert(
        libc::SYS_prlimit64,
        vec![condition(0, SeccompCmpOp::Eq, 0)?],
    );
    seccompiler::apply_filter(&program(
        rules,
        SeccompAction::Errno(libc::EPERM as u32),
        SeccompAction::Allow,
    )?)
    .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "linux"))]
fn sandbox() -> Result<(), String> {
    Ok(())
}

fn convert(format: &str, bytes: &[u8]) -> Result<Value, Failure> {
    match format {
        "pdf" => pdf(bytes),
        "docx" => office(bytes, anydoc::Format::Docx),
        "pptx" => office(bytes, anydoc::Format::Pptx),
        "xlsx" => office(bytes, anydoc::Format::Excel),
        "html" => html(bytes),
        "svg" => svg(bytes),
        _ => Err(fail(
            "unsupported",
            format!("No converter for the format {format}."),
        )),
    }
}

fn text(markdown: String) -> Result<Value, Failure> {
    if markdown.len() > MAX_TEXT_BYTES {
        return Err(fail("too-large", "The text is larger than 16 MiB."));
    }
    let mut text = markdown.trim_end().to_string();
    text.push('\n');
    Ok(json!({ "text": text }))
}

fn office(bytes: &[u8], format: anydoc::Format) -> Result<Value, Failure> {
    use anydoc::ConvertError as E;
    match anydoc::to_markdown_bytes(bytes, format) {
        Ok(markdown) => text(markdown),
        Err(E::Encrypted) => Err(fail("encrypted", "The file is encrypted.")),
        Err(E::ResourceLimit { limit, detail }) => {
            Err(fail("too-large", format!("{limit}: {detail}")))
        }
        Err(E::Unsupported(detail)) => Err(fail("malformed", detail)),
        Err(error) => Err(fail("malformed", error.to_string())),
    }
}

/// The text layer of a PDF. The pages with text give Markdown; the pages
/// with no text layer (scanned or image-only) are listed, not read.
fn pdf(bytes: &[u8]) -> Result<Value, Failure> {
    let options = pdf_inspector::PdfOptions::new().pages(1..=MAX_PDF_PAGES);
    let result = pdf_inspector::process_pdf_mem_with_options(bytes, options).map_err(|error| {
        let message = error.to_string();
        if message.to_lowercase().contains("encrypt") || message.to_lowercase().contains("password")
        {
            fail("encrypted", "The PDF is encrypted.")
        } else {
            fail("malformed", message)
        }
    })?;
    if result.page_count > MAX_PDF_PAGES {
        return Err(fail(
            "too-many-pages",
            format!(
                "The PDF has {} pages; the limit is {MAX_PDF_PAGES}.",
                result.page_count
            ),
        ));
    }
    let markdown = result.markdown.unwrap_or_default();
    if markdown.trim().is_empty() {
        return Err(fail(
            "no-text-layer",
            "The PDF has no text layer (scanned or image-only).",
        ));
    }
    let mut value = text(markdown)?;
    value["imageOnlyPages"] = json!(result.pages_needing_ocr);
    Ok(value)
}

/// HTML to Markdown. The tags that hold no reading text are skipped.
fn html(bytes: &[u8]) -> Result<Value, Failure> {
    let converter = htmd::HtmlToMarkdown::builder()
        .skip_tags(vec![
            "head", "script", "style", "noscript", "template", "nav", "svg", "iframe",
        ])
        .build();
    converter
        .convert(&String::from_utf8_lossy(bytes))
        .map_err(|error| fail("malformed", error.to_string()))
        .and_then(text)
}

/// An SVG to a PNG for the vision model, and the text of its labels in
/// document order. Before it renders, `prepare_svg` turns the parts that
/// resvg cannot draw into parts that it can.
fn svg(bytes: &[u8]) -> Result<Value, Failure> {
    let source =
        std::str::from_utf8(bytes).map_err(|_| fail("malformed", "The SVG is not UTF-8."))?;
    let source = plain_css(source);
    let document = roxmltree::Document::parse_with_options(
        &source,
        // A DTD is allowed: draw.io writes one. The node limit and the process
        // limits stop an entity expansion bomb.
        roxmltree::ParsingOptions {
            allow_dtd: true,
            nodes_limit: MAX_SVG_NODES as u32,
            ..Default::default()
        },
    )
    .map_err(|error| fail("malformed", error.to_string()))?;
    let labels = svg_labels(&document);
    let prepared = prepare_svg(&source, &document);

    let mut fonts = resvg::usvg::fontdb::Database::new();
    fonts.load_font_data(include_bytes!("../fonts/DejaVuSans.ttf").to_vec());
    fonts.set_sans_serif_family("DejaVu Sans");
    fonts.set_serif_family("DejaVu Sans");
    fonts.set_monospace_family("DejaVu Sans");
    fonts.set_cursive_family("DejaVu Sans");
    fonts.set_fantasy_family("DejaVu Sans");
    let options = resvg::usvg::Options {
        resources_dir: None,
        font_family: "DejaVu Sans".to_string(),
        fontdb: std::sync::Arc::new(fonts),
        // A data URL image is part of the file; a path or a URL is not read.
        image_href_resolver: resvg::usvg::ImageHrefResolver {
            resolve_data: resvg::usvg::ImageHrefResolver::default_data_resolver(),
            resolve_string: Box::new(|_, _| None),
        },
        ..resvg::usvg::Options::default()
    };
    let tree = resvg::usvg::Tree::from_str(&prepared, &options)
        .map_err(|error| fail("malformed", error.to_string()))?;
    let size = tree.size();
    if !(size.width() > 0.0 && size.height() > 0.0) {
        return Err(fail("malformed", "The SVG has no size."));
    }
    let scale = (MAX_SVG_SIDE / size.width().max(size.height())).min(2.0);
    let width = (size.width() * scale).ceil().max(1.0) as u32;
    let height = (size.height() * scale).ceil().max(1.0) as u32;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| fail("malformed", "The SVG has no drawable size."))?;
    pixmap.fill(resvg::tiny_skia::Color::WHITE);
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    let png = pixmap
        .encode_png()
        .map_err(|error| fail("malformed", error.to_string()))?;
    let mut value = text(labels.join("\n"))?;
    value["png"] = json!(base64::engine::general_purpose::STANDARD.encode(png));
    Ok(value)
}

/// The CSS functions that resvg does not read, as plain values (draw.io
/// writes them): `light-dark(a, b)` is its light value `a`, and
/// `var(--name, b)` is its fallback `b`. A fill that resvg cannot read is
/// black.
fn plain_css(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut rest = source;
    loop {
        let next = ["light-dark(", "var("]
            .iter()
            .filter_map(|name| rest.find(name).map(|at| (at, *name)))
            .min();
        let Some((at, name)) = next else { break };
        out.push_str(&rest[..at]);
        let inner = &rest[at + name.len()..];
        // The first argument ends at the first comma at depth 0, and the
        // call ends at its closing parenthesis.
        let (mut depth, mut comma, mut end) = (0i32, None, None);
        for (i, c) in inner.char_indices() {
            match c {
                '(' => depth += 1,
                ')' if depth == 0 => {
                    end = Some(i);
                    break;
                }
                ')' => depth -= 1,
                ',' if depth == 0 && comma.is_none() => comma = Some(i),
                _ => {}
            }
        }
        match (comma, end) {
            (Some(comma), Some(end)) => {
                let value = if name == "var(" {
                    &inner[comma + 1..end]
                } else {
                    &inner[..comma]
                };
                out.push_str(value.trim());
                rest = &inner[end + 1..];
            }
            _ => {
                out.push_str(name);
                rest = inner;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The text of one element: its words, joined with one space.
fn words(node: roxmltree::Node) -> String {
    let words: Vec<&str> = node
        .descendants()
        .filter(|child| child.is_text())
        .filter_map(|child| child.text())
        .flat_map(str::split_whitespace)
        .collect();
    words.join(" ")
}

/// True when `node` is in a branch of a `<switch>` that a full viewer does
/// not show: each child of a switch after the first element child.
fn in_fallback_branch(node: roxmltree::Node) -> bool {
    node.ancestors().any(|ancestor| {
        ancestor.parent().is_some_and(|parent| {
            parent.has_tag_name("switch")
                && parent
                    .first_element_child()
                    .is_some_and(|first| first != ancestor)
                && ancestor.is_element()
        })
    })
}

/// The labels of an SVG in document order: the `<text>` elements and the HTML
/// labels of the `<foreignObject>` elements (draw.io and Mermaid write
/// these), with the fallback branches of a `<switch>` left out.
fn svg_labels(document: &roxmltree::Document) -> Vec<String> {
    document
        .descendants()
        .filter(|node| node.has_tag_name("text") || node.has_tag_name("foreignObject"))
        // A text inside a label that is already taken is not taken again.
        .filter(|node| {
            !node
                .ancestors()
                .skip(1)
                .any(|a| a.has_tag_name("text") || a.has_tag_name("foreignObject"))
        })
        .filter(|node| !in_fallback_branch(*node))
        .map(words)
        .filter(|label| !label.is_empty())
        .collect()
}

/// A number of an SVG length attribute, with no unit or `px`.
fn length(node: roxmltree::Node, name: &str) -> Option<f32> {
    node.attribute(name)?
        .trim()
        .trim_end_matches("px")
        .parse::<f32>()
        .ok()
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The source of an SVG with the parts that resvg cannot draw changed:
/// - a `<switch>` whose first branch is an empty conditional group (a full
///   viewer shows nothing; draw.io puts its "Text is not SVG" notice in the
///   other branch) is removed;
/// - a `<foreignObject>` that is not in a `<switch>` (a Mermaid label) and
///   has a width and a height becomes an SVG `<text>` at its center. A
///   foreignObject in a switch keeps its fallback branch, which resvg draws.
fn prepare_svg(source: &str, document: &roxmltree::Document) -> String {
    let mut edits: Vec<(std::ops::Range<usize>, String)> = Vec::new();
    for node in document.descendants().filter(|node| node.is_element()) {
        if node.has_tag_name("switch") {
            let first = node.first_element_child();
            if first.is_some_and(|first| {
                first.attribute("requiredFeatures").is_some() && !first.has_children()
            }) {
                edits.push((node.range(), String::new()));
            }
        } else if node.has_tag_name("foreignObject")
            && !node.ancestors().any(|a| a.has_tag_name("switch"))
        {
            let (Some(width), Some(height)) = (length(node, "width"), length(node, "height"))
            else {
                continue;
            };
            let x = length(node, "x").unwrap_or(0.0) + width / 2.0;
            let y = length(node, "y").unwrap_or(0.0) + height / 2.0;
            edits.push((
                node.range(),
                format!(
                    "<text x=\"{x}\" y=\"{y}\" text-anchor=\"middle\" dominant-baseline=\"central\" font-size=\"14\">{}</text>",
                    escape_xml(&words(node))
                ),
            ));
        }
    }
    // A removed switch can hold an edited element: keep only the outer edit.
    edits.sort_by_key(|(range, _)| (range.start, std::cmp::Reverse(range.end)));
    let mut out = String::with_capacity(source.len());
    let mut at = 0;
    for (range, replacement) in edits {
        if range.start < at {
            continue;
        }
        out.push_str(&source[at..range.start]);
        out.push_str(&replacement);
        at = range.end;
    }
    out.push_str(&source[at..]);
    out
}

/// The filters on Linux: run with `cargo test` on a Linux host (the worker
/// image is Alpine). The filters go on one thread of the test only.
#[cfg(all(test, target_os = "linux"))]
mod tests {
    #[test]
    fn the_sandbox_refuses_files_sockets_and_processes_but_not_threads() {
        std::thread::spawn(|| {
            super::sandbox().expect("the filters go on");
            assert!(
                std::fs::File::open("/etc/hostname").is_err(),
                "a file opens"
            );
            assert!(
                std::net::TcpStream::connect("127.0.0.1:9").is_err(),
                "a socket opens"
            );
            for (name, changed) in [
                (
                    "a directory is made",
                    std::fs::create_dir("/tmp/ctxpipe-sandbox-dir"),
                ),
                (
                    "a symlink is made",
                    std::os::unix::fs::symlink("/", "/tmp/ctxpipe-sandbox-link"),
                ),
                (
                    "a file is renamed",
                    std::fs::rename("/tmp/ctxpipe-sandbox-a", "/tmp/ctxpipe-sandbox-b"),
                ),
                (
                    "a file is removed",
                    std::fs::remove_file("/tmp/ctxpipe-sandbox-a"),
                ),
            ] {
                assert_eq!(
                    changed.map_err(|error| error.raw_os_error()),
                    Err(Some(libc::EPERM)),
                    "{name}"
                );
            }
            // SAFETY: a fork that the filter refuses returns -1 and makes no child.
            assert_eq!(unsafe { libc::fork() }, -1, "a process starts");
            // SAFETY: a read of the limits of this process, then of the parent.
            let mut limit = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            let prlimit = |pid: libc::pid_t, limit: &mut libc::rlimit| unsafe {
                libc::syscall(
                    libc::SYS_prlimit64,
                    pid,
                    libc::RLIMIT_CPU,
                    std::ptr::null::<libc::rlimit>(),
                    limit,
                )
            };
            assert_eq!(
                prlimit(0, &mut limit),
                0,
                "a read of the limits of this process fails"
            );
            // SAFETY: the parent pid of this process.
            let parent = unsafe { libc::getppid() };
            assert_eq!(
                prlimit(parent, &mut limit),
                -1,
                "a read of the limits of another process works"
            );
            // SAFETY: a shared-memory segment and a message queue that the
            // filter refuses are not made.
            assert_eq!(
                unsafe { libc::shmget(libc::IPC_PRIVATE, 4096, libc::IPC_CREAT | 0o600) },
                -1,
                "a shared-memory segment is made"
            );
            assert_eq!(
                unsafe {
                    libc::syscall(
                        libc::SYS_mq_open,
                        c"ctxpipe-sandbox".as_ptr(),
                        libc::O_CREAT | libc::O_RDWR,
                        0o600,
                        std::ptr::null::<libc::c_void>(),
                    )
                },
                -1,
                "a message queue is made"
            );
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::EPERM),
                "the message queue fails with another error"
            );
            // SAFETY: a signal that the filter refuses goes nowhere.
            assert_eq!(
                unsafe { libc::kill(1, 0) },
                -1,
                "a signal goes to another process"
            );
            assert_eq!(
                std::thread::spawn(|| 7).join().unwrap(),
                7,
                "a thread does not start"
            );
        })
        .join()
        .expect("the sandbox test thread");
    }

    #[test]
    fn each_format_converts_within_the_sandbox() {
        let fixture = |name: &str| {
            std::fs::read(format!(
                "{}/../src/knowledge-plane/fixtures/convert/{name}",
                env!("CARGO_MANIFEST_DIR")
            ))
            .expect("a fixture of the backend")
        };
        let inputs: Vec<(&str, Vec<u8>)> = [
            "sample.pdf",
            "sample.docx",
            "sample.pptx",
            "sample.xlsx",
            "sample.html",
        ]
        .into_iter()
        .map(|name| (name.rsplit('.').next().unwrap_or(""), fixture(name)))
        .chain([(
            "svg",
            br#"<svg xmlns="http://www.w3.org/2000/svg" width="80" height="20"><text x="2" y="15">Label</text></svg>"#
                .to_vec(),
        )])
        .collect();
        std::thread::spawn(move || {
            super::sandbox().expect("the filters go on");
            for (format, bytes) in inputs {
                let value = super::convert(format, &bytes)
                    .unwrap_or_else(|failure| panic!("{format}: {}", failure.message));
                assert!(
                    value["text"].as_str().is_some_and(|text| !text.is_empty()),
                    "{format} gives no text"
                );
            }
        })
        .join()
        .expect("the conversion thread");
    }
}
