use std::path::PathBuf;

const DEFAULT_CUDA_DLLS: &[&str] = &[
    "cublas64_13.dll",
    "cublasLt64_13.dll",
    "curand64_10.dll",
    "nvrtc64_130_0.dll",
];

fn configure_cuda_delay_load() {
    let is_windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let is_msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    let has_qwen_cuda = std::env::var_os("CARGO_FEATURE_QWEN_CUDA").is_some();

    if !(is_windows && is_msvc && has_qwen_cuda) {
        return;
    }

    println!("cargo:rerun-if-env-changed=CUDA_PATH");

    let mut dlls = discover_cuda_dlls();
    if dlls.is_empty() {
        dlls = DEFAULT_CUDA_DLLS.iter().map(|s| (*s).to_string()).collect();
    }

    println!("cargo:rustc-env=BOOKREADER_CUDA_DLLS={}", dlls.join(","));
    println!("cargo:rustc-link-lib=delayimp");
    // Suppress LNK4199 when a test or binary target does not reference every delay-loaded DLL.
    println!("cargo:rustc-link-arg=/IGNORE:4199");
    println!("cargo:rustc-link-arg=/DELAYLOAD:nvcuda.dll");
    for dll in &dlls {
        println!("cargo:rustc-link-arg=/DELAYLOAD:{dll}");
    }
}

fn discover_cuda_dlls() -> Vec<String> {
    let Some(cuda_path) = std::env::var_os("CUDA_PATH") else {
        return Vec::new();
    };
    let root = PathBuf::from(cuda_path);
    let mut found = Vec::new();

    for dir in [root.join("bin"), root.join("bin").join("x64")] {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let lower = name.to_ascii_lowercase();
            let is_cuda_runtime_dep = (lower.starts_with("cublas64_")
                || lower.starts_with("cublaslt64_")
                || lower.starts_with("curand64_")
                || lower.starts_with("nvrtc64_"))
                && !lower.starts_with("nvrtc-builtins")
                && lower.ends_with(".dll");

            if is_cuda_runtime_dep {
                found.push(name.to_string());
            }
        }
    }

    found.sort();
    found.dedup();
    found
}

fn main() {
    configure_cuda_delay_load();
    tauri_build::build();
}
