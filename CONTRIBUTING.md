# Contributing to ShowMe

Use Node.js 24 or 26 and install the locked dependencies with `npm ci`.
Run `npm run desktop` for the desktop app or `npm run dev` for browser development.
Desktop filesystem, export, MCP and presenter behavior also need desktop verification.

Before making changes, read [AGENTS.md](AGENTS.md) for architecture, compatibility
and workflow rules. Keep changes focused and preserve the version 1 document and
protocol contracts. Include a reproduction for bug fixes and explain intentional
behavior changes.

Run the smallest meaningful checks described in [tests/README.md](tests/README.md).
Use `npm run typecheck` and `npm run lint` for TypeScript changes. Register new test
files in `tests/registry.json`; run `npm run test:stats` and `npm run test:audit` when
test composition changes. Report the exact commands and results in your pull request.
Automatic CI is currently paused, so local verification matters.

Report bugs and propose features through the repository's
[issues](https://github.com/KonradJuenger/ShowMe/issues). Include your OS, ShowMe
version or commit, reproduction steps, expected behavior and actual behavior.
Remove private media, presentation content and local paths from attachments.
For security reports, follow [SECURITY.md](SECURITY.md).

By submitting a contribution, you agree to license it under the project's
[AGPL-3.0-or-later license](LICENSE).
