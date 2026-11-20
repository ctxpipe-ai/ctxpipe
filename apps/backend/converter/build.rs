//! The version of the converter: the package version and a hash of what
//! decides its output. That is the locked dependencies, the source, the font
//! and the `rustc --version` of the compiler that cargo builds with
//! (`rust-toolchain.toml` pins it). The compiler is part of the converter.
//! The same hash gives the same text for the same bytes.
use sha2::{Digest, Sha256};

fn main() {
    let mut hash = Sha256::new();
    for path in ["Cargo.lock", "src/main.rs", "fonts/DejaVuSans.ttf"] {
        println!("cargo:rerun-if-changed={path}");
        hash.update(path.as_bytes());
        hash.update(std::fs::read(path).expect("a file of the converter"));
    }
    // The compiler: cargo gives a build script the compiler that it builds
    // with. Its version names the exact Rust, also when an override replaces
    // the pin. A change of the pin runs this script again.
    println!("cargo:rerun-if-changed=rust-toolchain.toml");
    let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".into());
    let version = std::process::Command::new(rustc)
        .arg("--version")
        .output()
        .expect("the Rust compiler of the build");
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
