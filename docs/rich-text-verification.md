# Inline text verification

Verified locally on Windows on 2026-11-03. The pull-request branch is based on `origin/main` and contains only inline-text changes.

## Static and build checks

Passed: `npm run build` (includes TypeScript validation), `npm run typecheck`, `npm run lint`, `npm run test:stats`, `npm run test:audit`, and `git diff --check`. Registry: 745 active declarations in 112 groups.

## Focused domain and persistence checks

172 tests passed in 19 selected files. Run in PowerShell:

```powershell
$env:SHOWME_TEST_FILES = @(
  "tests/core/document.test.ts"
  "tests/core/persistence.test.ts"
  "tests/feature/editor/agentEditing.test.ts"
  "tests/feature/editor/agentInspection.test.ts"
  "tests/feature/editor/agentProjection.test.ts"
  "tests/feature/editor/text-styles.test.ts"
  "tests/feature/html-export/html-export.test.ts"
  "tests/feature/persistence/export-fonts.test.ts"
  "tests/feature/persistence/lan-work.test.ts"
  "tests/feature/persistence/text-style-transfer.test.ts"
  "tests/feature/editor/text-runs.test.ts"
  "tests/feature/persistence/text-runs.test.ts"
  "tests/feature/editor/text-style-authority.test.ts"
  "tests/feature/persistence/recovery.test.ts"
  "tests/feature/persistence/text-style-storage.test.ts"
  "tests/feature/persistence/package-fonts.test.ts"
  "tests/feature/persistence/css-export-fonts.test.ts"
  "tests/feature/html-export/text-outlines.test.ts"
  "tests/feature/persistence/current-formats.test.ts"
) | ConvertTo-Json -Compress
node node_modules/vitest/vitest.mjs run --maxWorkers=1
Remove-Item Env:SHOWME_TEST_FILES
```

The unit selection runs serially because a concurrent invocation exposed an `ENOTEMPTY` error in the existing CSS-font temporary-library cleanup. No retries or assertions were changed.

## Browser editing and export checks

10 tests passed, including native character selection, toolbar focus, caret formatting, synthetic composition, plain-text paste, deletion/inheritance, actor history while editing, IndexedDB reload, DOM measurement, shared Text Styles, PowerPoint rich-run round trip and PDF readiness.

```powershell
$env:SHOWME_TEST_FILES='["tests/feature/editor/text-runs.spec.ts","tests/feature/editor/text-styles.spec.ts"]'
npx playwright test --output test-results-rich-text-editor
Remove-Item Env:SHOWME_TEST_FILES
```

The two existing browser-ownership checks also passed in an earlier combined invocation.

## Native Electron font export

One test passed using actual Asap Condensed regular and bold font files in an isolated library, exercising Chromium fragment layout, verified outline shaping and offline HTML playback.

```powershell
$env:SHOWME_TEST_FILES='["tests/feature/html-export/font-svg-native.spec.ts"]'
npx playwright test --config playwright.electron.config.ts --output test-results-rich-text-electron
Remove-Item Env:SHOWME_TEST_FILES
```

## Audience-navigation gate

Both declarations executed and passed: dense animated rendering stress and late-image preparation/navigation. The stress workload and assertions are unchanged apart from the fixture using current text runs. This correctness check is not a comparable performance benchmark.

```powershell
$env:SHOWME_TEST_FILES='["tests/feature/presenter/audience-navigation.spec.ts"]'
npx playwright test tests/feature/presenter/audience-navigation.spec.ts --output test-results-rich-text-audience
Remove-Item Env:SHOWME_TEST_FILES
```


## Not run

Full/release suites, packaging, manual OS IME input, and macOS verification were not run. Composition coverage uses dispatched browser composition events rather than a real OS input method.
