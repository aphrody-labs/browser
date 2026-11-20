set dotenv-load
set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

# List browser recipes
default:
    @just --list

# Fast Rust workspace check
check:
    cargo check --workspace

# Clippy with warnings denied
lint:
    cargo clippy --workspace --all-targets -- -D warnings

# Format Rust sources
fmt:
    cargo fmt --all

# Run Rust workspace tests
test:
    cargo test --workspace

# Run Bun tests for browser packages and chromium-dash
test-js:
    bun test ./packages ./apps/chromium-dash
