//! The version of the converter: the package version and a hash of what
//! decides its output (the locked dependencies, the source and the font).
//! The same hash gives the same text for the same bytes.
use sha2::{Digest, Sha256};

fn main() {
    let mut hash = Sha256::new();
    for path in ["Cargo.lock", "src/main.rs", "fonts/DejaVuSans.ttf"] {
        println!("cargo:rerun-if-changed={path}");
        hash.update(path.as_bytes());
        hash.update(std::fs::read(path).expect("a file of the converter"));
    }
    let hex: String = hash
        .finalize()
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    println!("cargo:rustc-env=CONVERTER_HASH={hex}");
}
