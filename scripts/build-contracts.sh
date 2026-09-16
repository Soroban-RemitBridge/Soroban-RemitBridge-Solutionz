#!/usr/bin/env bash
#
# Build every Soroban contract to Wasm.
#
# Two things here are deliberate:
#
#   1. `--release` with `opt-level = "z"` (see the workspace profile). Deployment
#      cost on Soroban is a function of Wasm size, so a debug build is not just
#      slower, it is more expensive to deploy.
#   2. The output path is printed rather than assumed. `deploy-contracts.ts`
#      reads the same directory, and a silent change to Cargo's target layout
#      would otherwise surface as a confusing "file not found" during a deploy.
#
# `cargo test` and `clippy` are intentionally *not* run here. Building an artifact
# and verifying the code are separate steps with separate failure meanings, and
# CI runs both.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="${REPO_ROOT}/contracts"

# `wasm32v1-none`, NOT `wasm32-unknown-unknown`.
#
# Since Rust 1.82 the `wasm32-unknown-unknown` target enables WebAssembly
# features that are *not* part of the MVP -- `reference-types`, and more once the
# toolchain bumps again. A toolchain never notices: the Wasm builds, and even the
# export-table assertion in CI can parse it, because Node's WebAssembly engine
# supports those features. Soroban's VM does not, so the artifact is rejected at
# upload with `Error(WasmVm, InvalidAction)` and a parser message about a byte
# offset. That failure appears only on a real deploy, which is the worst place to
# find it, and `-C target-feature=-reference-types` does not reliably fix it
# because the next bump re-enables the next feature.
#
# `wasm32v1-none` is the target that exists for this: WebAssembly 1.0 only, no
# proposals, no std. Both targets are listed in `rust-toolchain.toml`.
TARGET="wasm32v1-none"
OUT_DIR="${CONTRACTS_DIR}/target/${TARGET}/release"

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo is not on PATH. Install the Rust toolchain first." >&2
  exit 1
fi

if ! rustup target list --installed 2>/dev/null | grep -q "^${TARGET}$"; then
  echo "error: the ${TARGET} target is not installed." >&2
  echo "       run: rustup target add ${TARGET}" >&2
  exit 1
fi

CRATES=(agent-registry compliance-hook remit-escrow liquidity-pool)

PACKAGE_ARGS=()
for crate in "${CRATES[@]}"; do
  PACKAGE_ARGS+=("-p" "${crate}")
done

echo "Building contracts for ${TARGET}…"
cargo build \
  --manifest-path "${CONTRACTS_DIR}/Cargo.toml" \
  --release \
  --target "${TARGET}" \
  "${PACKAGE_ARGS[@]}"

echo
echo "Artifacts in ${OUT_DIR}:"
for crate in "${CRATES[@]}"; do
  # Cargo underscores the artifact name even when the package name is hyphenated.
  artifact="${OUT_DIR}/$(echo "${crate}" | tr '-' '_').wasm"
  if [[ ! -f "${artifact}" ]]; then
    echo "error: expected artifact is missing: ${artifact}" >&2
    exit 1
  fi
  printf '  %-24s %8s bytes\n' "$(basename "${artifact}")" "$(wc -c < "${artifact}" | tr -d ' ')"
done

echo
echo "Next: npm run deploy   (from the scripts/ directory)"
