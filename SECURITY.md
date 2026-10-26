# Security

ShowMe is pre-1.0 software. Security fixes target the current development version;
older snapshots do not have a separate maintenance commitment.

For a suspected vulnerability, use GitHub's **Report a vulnerability** option in
the repository's Security tab if private reporting is enabled. If it is unavailable,
open an issue asking the maintainer for a private reporting channel without posting
exploit details, credentials or private presentation data. No dedicated security
email address or response-time guarantee is currently published.

Include the affected commit/version, OS, reproduction steps, impact and any proposed
fix in the private report.

## Trust boundaries

- Electron windows use context isolation and sandboxing with Node integration disabled.
- CSS, JavaScript and GLSL effects are programmable content. Review presentation
  effects before using presentations from untrusted sources.
- Experimental LAN collaboration is intended for trusted networks and is unencrypted.
- Local MCP and agent editing are disabled by default. Enable them only for trusted
  local clients. Agent editing can change and save presentations when allowed.

See [the release assessment](docs/PUBLIC_RELEASE_READINESS.md) for known outstanding
release work. These boundaries do not replace dependency and desktop verification.
