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
/// build.rs makes of Cargo.lock, the source and the font. It is part of the
/// projection version (ADR-067).
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
/// each system call that opens a file, makes a socket, starts a program or
/// a process, reads, signals or changes another process, or gives an
/// indirect way to do one of these (io_uring, bpf) fails with EPERM. The
/// calls that set the limits or the scheduling of a process work only on
/// this process (pid 0): all the converters run as `nobody`, so another
/// pid can be the converter of another organization. A new thread (`clone` with
/// `CLONE_THREAD`) still works: a parser can use threads, but no process.
/// `clone3` fails with ENOSYS, so that the C library uses `clone`, whose
/// flags the filter can read. The parsers need none of the refused calls:
/// the input is in memory and the output goes to stdout, which is open. The
/// threads that a parser starts later get the same filters.
#[cfg(target_os = "linux")]
fn sandbox() -> Result<(), String> {
    use seccompiler::{
        BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
        SeccompRule,
    };
    let arch = std::env::consts::ARCH
        .try_into()
        .map_err(|_| "no seccomp target for this arch".to_string())?;
    // x86_64 adds the old calls that arm64 does not have.
    #[cfg_attr(not(target_arch = "x86_64"), allow(unused_mut))]
    let mut refused = vec![
        libc::SYS_openat,
        libc::SYS_openat2,
        libc::SYS_open_by_handle_at,
        libc::SYS_name_to_handle_at,
        libc::SYS_socket,
        libc::SYS_socketpair,
        libc::SYS_connect,
        libc::SYS_bind,
        libc::SYS_listen,
        libc::SYS_accept4,
        libc::SYS_sendto,
        libc::SYS_sendmsg,
        libc::SYS_sendmmsg,
        libc::SYS_execve,
        libc::SYS_execveat,
        libc::SYS_ptrace,
        libc::SYS_process_vm_readv,
        libc::SYS_process_vm_writev,
        // Another process: its file descriptors, or a signal to it. An abort
        // of this process still ends it (the C library then crashes it).
        libc::SYS_pidfd_open,
        libc::SYS_pidfd_getfd,
        libc::SYS_pidfd_send_signal,
        libc::SYS_kcmp,
        libc::SYS_kill,
        libc::SYS_tkill,
        libc::SYS_tgkill,
        libc::SYS_rt_sigqueueinfo,
        libc::SYS_rt_tgsigqueueinfo,
        // The priority or the memory of another process.
        libc::SYS_setpriority,
        libc::SYS_ioprio_set,
        libc::SYS_migrate_pages,
        libc::SYS_move_pages,
        libc::SYS_process_madvise,
        libc::SYS_io_uring_setup,
        libc::SYS_io_uring_enter,
        libc::SYS_io_uring_register,
        libc::SYS_bpf,
        libc::SYS_perf_event_open,
        libc::SYS_userfaultfd,
        libc::SYS_memfd_create,
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_unshare,
        libc::SYS_setns,
        libc::SYS_chroot,
        libc::SYS_pivot_root,
    ];
    #[cfg(target_arch = "x86_64")]
    refused.extend([
        libc::SYS_open,
        libc::SYS_creat,
        libc::SYS_accept,
        libc::SYS_fork,
        libc::SYS_vfork,
    ]);
    let mut rules: std::collections::BTreeMap<i64, Vec<SeccompRule>> =
        refused.into_iter().map(|call| (call, vec![])).collect();
    // A clone that is not a thread is a new process.
    let not_a_thread = SeccompCondition::new(
        0,
        SeccompCmpArgLen::Qword,
        SeccompCmpOp::MaskedEq(libc::CLONE_THREAD as u64),
        0,
    )
    .map_err(|error| error.to_string())?;
    rules.insert(
        libc::SYS_clone,
        vec![SeccompRule::new(vec![not_a_thread]).map_err(|error| error.to_string())?],
    );
    // The limits or the scheduling of a process other than this one.
    for call in [
        libc::SYS_prlimit64,
        libc::SYS_sched_setaffinity,
        libc::SYS_sched_setscheduler,
        libc::SYS_sched_setparam,
        libc::SYS_sched_setattr,
    ] {
        let another_process =
            SeccompCondition::new(0, SeccompCmpArgLen::Dword, SeccompCmpOp::Ne, 0)
                .map_err(|error| error.to_string())?;
        rules.insert(
            call,
            vec![SeccompRule::new(vec![another_process]).map_err(|error| error.to_string())?],
        );
    }
    let program = |rules, action| -> Result<BpfProgram, String> {
        SeccompFilter::new(rules, SeccompAction::Allow, action, arch)
            .map_err(|error| error.to_string())?
            .try_into()
            .map_err(|error: seccompiler::BackendError| error.to_string())
    };
    seccompiler::apply_filter(&program(rules, SeccompAction::Errno(libc::EPERM as u32))?)
        .map_err(|error| error.to_string())?;
    let clone3 = [(libc::SYS_clone3, vec![])].into_iter().collect();
    seccompiler::apply_filter(&program(clone3, SeccompAction::Errno(libc::ENOSYS as u32))?)
        .map_err(|error| error.to_string())
}

/// No seccomp outside Linux: the worker runs on Linux, and a developer host
/// relies on the limits of the caller.
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
}
