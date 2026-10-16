# ShowMe

<!-- impeccable:product-schema 1 -->

## Platform

web

ShowMe is a desktop presentation editor for macOS and Windows, built with
React, TypeScript, Vite, and Electron. Its interface uses web technologies;
browser development is available through `npm run dev` at
`http://127.0.0.1:5173`. The desktop build runs through `npm run desktop`.

## Users

Designers, hackers, technology enthusiasts, and developers who value local
software that works, stays free of clutter, and requires no subscription.
They create and present media-rich presentations and reuse materials across
different presentations.

## Product Purpose

Make expressive presentations practical to create, maintain, share, and run
with local software. Success means responsive editing and presentation
playback, dependable access to local files, reusable media without duplicate
storage, and a straightforward interface.

## Positioning

ShowMe combines a local-first presentation editor with a central,
content-addressed media library that deduplicates assets across presentations.
Programmable CSS, JavaScript, and GLSL effects support users who want to go
beyond conventional slide content.

The product direction prioritizes snappy performance and high-quality local
collaboration supported by Syncthing, while remaining clutter-free and
subscription-free. Collaboration quality is a priority, not a claim that the
current experimental implementation is finished.

## Operating Context

- Create and edit slides, reuse media, Text Styles, and Templates, arrange
  Motion and Click Timeline steps, and present with speaker notes and controls.
- Work locally on macOS or Windows. Use `.sme` presentations with the managed
  media library and `.smp` packages for portable presentations.
- For collaboration, synchronize the complete ShowMe root, including
  `ShowMe Library/` and the `.sme` presentations using it, with Syncthing or
  equivalent file synchronization. Each computer selects its own local copy
  of the same root; absolute paths may differ.
- LAN collaboration synchronizes presentation edits. File synchronization
  supplies the documents and media; these are distinct responsibilities.

## Capabilities and Constraints

- Existing capabilities include media editing, programmable effects, Motion,
  Click Timeline, slide transitions, reusable Text Styles and Templates,
  presenter tools, PowerPoint import/export, and PDF export.
- LAN collaboration is currently experimental and intended for trusted local
  networks; its connection is not encrypted.
- Missing media uses a placeholder and updates when the asset becomes
  available locally. Fonts are normally not embedded, so typography can vary
  between computers without the same fonts.
- Preserve established editing, keyboard, IME, history, clipboard, media,
  navigation, presenter, collaboration, and save/open/recovery/export behavior
  during unrelated design work.
- Keep the single document ownership and persistence path defined in
  `AGENTS.md`. Solo editing and collaboration share `DocumentAuthority`.
- Public version 1 is the compatibility baseline. Preserve current document,
  `.sme`, `.smp`, asset, recovery, slide-transfer, and collaboration formats
  under the repository's versioning policy.

## Brand Commitments

The product name is ShowMe. Keep the product focused on useful local software,
technical expressiveness, and freedom from clutter and subscriptions.

## Evidence on Hand

- `README.md` documents current capabilities, local workflows, installation,
  file formats, and collaboration limitations.
- `docs/images/` contains editor, effects, motion, assets, typography, and
  presenter screenshots referenced by the README.
- `areweslowyet.md` records audience-rendering benchmark observations.
- `AGENTS.md` defines architecture, compatibility, behavior-preservation, and
  verification requirements.

Use these sources for concrete product claims. Do not invent performance
figures, collaboration guarantees, customer endorsements, or accessibility
certification.

## Product Principles

1. Keep local ownership and subscription-free use central to product decisions.
2. Make shared media reuse reliable and avoid duplicate storage across decks.
3. Treat responsive editing and presentation playback as product quality.
4. Make local collaboration dependable across synchronized files and live edits.
5. Reduce clutter while preserving expressive tools and established workflows.
