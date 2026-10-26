# ShowMe tests

Run the smallest meaningful set. `npm test` runs only the core contracts;
`npm run test:feature -- media` runs just that feature's maintained tests.
Initial feature areas: editor, media, motion, effects, persistence, presenter.
An unknown or uncovered area fails clearly rather than running unrelated tests.

| Command | Selection / preparation |
| --- | --- |
| `npm test`, `npm run test:core` | Active core, no browser startup |
| `npm run test:feature -- <area>` | Active feature tier in that area |
| `npm run test:extended` | Active extended domain and browser integration |
| `npm run test:full` | Active core + feature + extended, across runtimes |
| `npm run test:release` | Full + build/verify + release Electron and packaged checks; packages the current host |
| `npm run test:deprecated` | Retained executable deprecated groups, never implicit |
| `npm run test:stats` | Derive and write committed `tests/stats.json` |
| `npm run test:audit` | Validate registry, source inventory and committed stats |

Install Chromium once with `npx playwright install chromium` before browser
verification. Release verification requires Windows or macOS and native packaging
prerequisites. The manual desktop workflow checks both platforms. There are no retries;
traces/screenshots are retained only for failures.

Electron groups run sequentially in separate Playwright processes. Native groups
can own in-process Vite servers and compositor capture fixtures; sharing the
automation/compiler process across unrelated files caused capture stalls that did
not occur in isolated runs. Each registered file still runs once, without retries,
with artifacts under `test-results-electron/<group-id>/`.

`registry.json` owns selection; folders express product responsibility. Moving a
group between tiers requires only metadata editing; moving its file is optional.
Every `.test.ts` / `.spec.ts` is registered exactly once. Unit files use Vitest;
browser, Electron and packaged files use Playwright. Helpers never register tests.
Use explicit `it("contract", ...)` or `test("contract", ...)` declarations; no
`.each`, `.skip`, `.only`, `.todo`, loops or conditional registration. The parser
counts declarations, not assertion lines. Do not alias runners through custom
wrappers. Keep domain files focused and small.

Core is tiny, fast and stable. Feature is the everyday working tier. Extended
protects workflows across subsystems. Release protects expensive runtime and
packaged boundaries. Status is `active`, `deprecated`, or `quarantine`.
Quarantine retains its intended tier but requires `quarantineReason` and `reviewBy`;
normal commands exclude it. Investigate via explicit runtime file invocation;
restore it to active or remove it by that date. Never hide failures with retries.

Deprecation sets both tier and status to `deprecated`, with `deprecationReason`
and `removeAfter` (normally 30 days). Executable source may be deleted immediately;
the record stays until that cleanup date. Delete expired records during the next
touch to the area.

Statistics distinguish active **test declarations** from deprecated/quarantined
**group records**. Deleted executables contribute no declarations. Counts by tier,
area and runtime cover active tests, including release. `test:full` leaves release
checks to `test:release`. Stats contain no timestamps or measured durations: they
are deterministic, cheap and reviewable. Run `test:stats` after composition changes
and commit the output; audit rejects stale output.
