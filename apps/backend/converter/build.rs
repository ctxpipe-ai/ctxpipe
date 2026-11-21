//! The version of the converter: the package version and a hash of what
//! decides its output. That is the locked dependencies (also Kingfisher and
//! its rules, for `--scrub`), the source, the font
//! and the `rustc --version` of the compiler that cargo builds with
//! (`rust-toolchain.toml` pins it). The compiler is part of the converter.
//! The same hash gives the same text for the same bytes.
use sha2::{Digest, Sha256};

fn main() {
    let mut hash = Sha256::new();
    for path in [
        "Cargo.lock",
        "src/main.rs",
        "src/scrub.rs",
        "fonts/DejaVuSans.ttf",
    ] {
        println!("cargo:rerun-if-changed={path}");
        hash.update(path.as_bytes());
        hash.update(std::fs::read(path).expect("a file of the converter"));
    }
    // The compiler: cargo gives a build script the compiler that it builds
    // with. Its version names the exact Rust, also when an override replaces
    // the pin.
    let rustc = std::env::var("RUSTC").expect("cargo sets RUSTC");
    let version = std::process::Command::new(rustc)
        .arg("--version")
        .output()
        .expect("the Rust compiler of the build");
    assert!(
        version.status.success() && !version.stdout.is_empty(),
        "rustc --version gives no version"
    );
    hash.update(b"rustc");
    hash.update(version.stdout);
    let hex: String = hash
        .finalize()
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    println!("cargo:rustc-env=CONVERTER_HASH={hex}");
}
