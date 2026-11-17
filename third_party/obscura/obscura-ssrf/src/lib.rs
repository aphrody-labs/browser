//! Shared SSRF policy for Obscura transports and renderers, backed by [`browser_detect::ssrf`].

pub use browser_detect::ssrf::is_forbidden_ip;

/// Process-wide opt-in via env var (`OBSCURA_ALLOW_PRIVATE_NETWORK`).
pub fn env_allows_private_network() -> bool {
    matches!(
        std::env::var("OBSCURA_ALLOW_PRIVATE_NETWORK")
            .ok()
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("1") | Some("true") | Some("yes") | Some("on")
    )
}
