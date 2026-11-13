# Independent review handoff — PDFfy 0.1.0-beta.1

## Review target and publication status

Review the combined **PDF to Figma / Figma to PDF** beta for functional correctness, fidelity, cancellation, resource handling and exporter regressions. Identify concrete triggers and observable failures; separate verified defects from unsupported features and missing evidence.

The public repository is [iamdbuko/PDFfy](https://github.com/iamdbuko/PDFfy). At this preparation checkpoint on November 13, 2026, version **0.1.0-beta.1** is set in the package files. The public repository has been created and the local repository initialized on `main`. Figma assigned PDFfy ID **`1703175034563542365`**, saved in the manifest. Its beta listing form is prepared but **not published**. First-release source push, exact-candidate hosted CI, GitHub release, Figma publication and Community-installed verification are still pending.

Read [PROJECT_MEMORY.md](../PROJECT_MEMORY.md), [README.md](../README.md) and [RELEASING.md](RELEASING.md). The [development-preview validation](PDFFY-VALIDATION.md) is historical evidence for the earlier build. The updated beta full local suite passed **340/340 tests** after the upstream and renderer corrections. The current generated build also passed the actual Desktop plugin's covered core flow and independent saved-output checks. See [BETA-VALIDATION.md](BETA-VALIDATION.md); hosted CI, publication and Community-installed verification remain pending.

## Upstream provenance and synchronization

The exporter derives from [Figma-to-PDF with links and multiple pages v9.0.2](https://github.com/iamdbuko/Figma-to-PDF-with-links-and-multiple-pages/releases/tag/v9.0.2), published tag commit `2fef2bc5ff82e7fffd3b208b32d1314f78cdf4ca`. Upstream documentation checkpoint `132ab8f` records the verified Community Version 11 release. See its [project memory](https://github.com/iamdbuko/Figma-to-PDF-with-links-and-multiple-pages/blob/main/PROJECT_MEMORY.md) and [release validation](https://github.com/iamdbuko/Figma-to-PDF-with-links-and-multiple-pages/blob/main/docs/releases/v9.0.2-validation.json) for that history.

PDFfy's first preview was copied before the final shared-mask accounting correction. Beta preparation replaced `src/pdf-image-resolution.js` and `tests/pdf-image-resolution.test.js` with the final upstream files. Review that parity explicitly: when a JPEG resize would retain an old shared mask elsewhere, its bytes cannot be counted as removable savings. Unknown or oversized ownership graphs receive no mask-savings credit. Keep the RGB-only safeguard, unchanged CMYK path, visible retained-original warning and existing resource limits.

Other retained exporter helpers/assets/licenses match the audited baseline. The intended integration differences are the mode shell, import routing, operation locking, import-time selection handling and window height. Upstream tests/native report results are provenance, not proof of the combined beta's behavior.

## Runtime map

| Source | Responsibility |
| --- | --- |
| `src/export-main.js` | Figma export selection, ordering, bounds/links, source-change checks, rendering, acknowledgements and cancellation; routes the import protocol |
| `src/import-main.js` | Figma page/section/layer creation, font matching and remapping, layout, hyperlink hotspots, import sequencing and rollback |
| `src/pdf-import.js` | Local PDF.js loading/passwords, previews, ranges, PDF operators, ordered editable layers, page images and PDF links |
| `src/import-ui.js` | File queue, page selection, previews, font controls, progress, cancellation and acknowledgement lifecycle |
| `src/import-shell.html` | Mode switch, import controls, password dialog and combined layout |
| `src/ui.html` | Retained exporter interface, settings, PDF assembly, links, output parts and download lifecycle |
| `src/pdf-image-resolution.js`, `src/pdf-resource-pruning.js`, `src/pdf-loader.js` | Conservative native-PDF resource processing, image downsizing and pinned-library import adapter |
| `src/color-profiles.js`, `src/cmyk.js`, `src/vector-cmyk.js`, `src/pdf-functions.js` | Retained RGB profile and offline CMYK conversion behavior |
| `src/cooperative-yield.js` | Cooperative exporter scheduling |
| `scripts/build.mjs` | Generates `code.js` and `ui.html`, bundling pinned runtimes, fonts, character maps, decoders and notices |

The runtime manifest permits no network access. Dependencies are pinned: PDF.js 6.5.438, pdf-lib 1.17.1, jpeg-js 0.4.4 and lcms-wasm 1.0.5. Do not edit generated runtime files directly or substitute remote libraries to make a test pass.

## Behavior to protect

**Mode switching and export.** Both modes remain mounted, preserving settings and the file queue. Switching locks while work is active. Retain the two export screens, every-listed-frame behavior, ID-based links/order, drag and stable natural sorting, Remove/Clear, default settings and custom ICC bytes. Preserve vector/raster options, independent resolutions, RGB/CMYK handling, links, multipart downloads and source-edit cancellation. Export must not mutate source designs.

**Import fidelity.** Editable mode uses ordered SVG and native text elements so drawing order survives. Images remain image fills within the imported structure. Check mixed sizes, rotation, image placement, vector strokes/fills, supported gradients, clipping, opacity and hyperlink bounds/targets. Batch/range processing must map internal links to the selected destination page in the same source document. Page-image density changes pixels, not page frame dimensions.

**Text and fonts.** Verify source weight/style detection, explicit mappings, unavailable-font warnings and remapping of the last completed import only. Figma transform axes must be normalized; nonuniform PDF glyph scaling is approximated through spacing with a warning. Preserve user edits made while replacement fonts are loading. A remap error must restore earlier changes and display an error. Nonpainting Type 3 search metadata must not duplicate outlined lettering. Painted Type 3 programs must not silently become blank or substituted artwork.

**Lifecycle.** Import-start reserves one job before asynchronous work. Each page is acknowledged before another is sent; stale/repeated messages cannot create duplicate pages. Error/cancel removes only the active import's partial section. A cancellation arriving after commit must report that pages remain. No late text/SVG creation may occur after cancellation. Mode controls must stay locked until the backend outcome is known. Password retry/skip, font-scan cancel, document removal/clear, failure/retry and source-page changes need coverage.

**Resources and offline use.** Keep the documented file, page/image, operator, layer, payload and layout limits. Release removed documents and temporary raster buffers. Decode bundled resources without HTTP requests. Small compressed files can still contain expensive drawings, so input byte limits do not establish total-memory bounds.

## Explicit beta limits

This is not a full-fidelity or complete pdf.to.design PRO parity claim. See [IMPORT-COMPARISON.md](IMPORT-COMPARISON.md) for the documented comparison.

- Figma Design is supported; FigJam, Slides and Buzz are not implemented.
- Scans stay images. OCR, paragraph/auto-layout recovery, interactive forms and bookmarks are outside the current implementation.
- Outlined letters remain vectors. Substitution, metrics, kerning, font size limits and nonuniform scaling can alter native text appearance.
- Unsupported masks, blends, clipping/text modes, Type 3 glyph programs, patterns and gradient variants must fail clearly in editable mode. Page images are an explicit alternative.
- Import does not apply embedded ICC profiles: PDF.js's alternate conversion also drives previews. Matching a preview does not prove color accuracy against a color-managed PDF viewer. Export CMYK support does not provide a lossless CMYK/ICC round trip.
- UI limits are 128 MiB per file and 256 MiB queued, plus the README's drawing/image limits. No 10 GB support or arbitrary-document guarantee is claimed.

## Verification and review evidence

The renderer's focused suite reached 14 passing tests after font-weight and nonrectangular-clip corrections. The complete updated beta local suite subsequently passed 340/340 tests. The earlier preview's complete-suite/API-bridge records remain labeled with that build. The current beta's actual Desktop core flow also passed:

| Native check | Observed result |
| --- | --- |
| Editable pages and arrangement | Two mixed-size pages, rotation and grid arrangement verified |
| Font controls and ranges | Font detection/remapping and invalid-range handling exercised |
| Batch/password/outline content | Encrypted PDF retry and outlined-text import passed; ten URL hotspots verified |
| Page images | 2× image measured 1,200 × 800 pixels inside a 600 × 400 frame |
| Native Undo | Removed only the latest import |
| Cancellation | A 40-page import cancelled during page two left no partial artifacts; the three preceding sections remained and controls unlocked |
| Saved exports | RGB and CMYK exports and raster sRGB output independently inspected |

These are scoped development-plugin results, not a Community-installed test. Text-metric differences and JPEG artifacts are recorded limitations, not hidden by a blanket visual-fidelity claim. Detailed local round-trip and batch-link checks remain in ignored test results; [BETA-VALIDATION.md](BETA-VALIDATION.md) records safe aggregate evidence. Hosted CI and release verification remain pending; do not add unverified hashes, CI URLs or publication claims.

Use Node.js 22.13+ or 24+. From the repository root:

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm run build
node --check code.js
npm test
git diff --check
git diff --exit-code -- code.js ui.html licenses/
```

Review `tests/pdf-import.test.js`, `tests/import-protocol.test.js` and `tests/import-ui.test.js` together: renderer assertions, mocked protocol checks and browser UI behavior cover different boundaries. Also retain the complete exporter suite, especially image-resolution/assembly, links, protocol, controls, profiles, CMYK and lifecycle cases.

For future candidate changes and the Community-installed check, repeat the affected Desktop paths: editable/image imports, protected PDF retry/skip, page ranges/batch arrangement, font choices/remapping, cancellation, mode retention and export of an imported synthetic sample. Inspect created Figma layers, then saved PDF geometry, links, text/vector/image content and rendered output. Neither a download nor an API bridge smoke test alone establishes that end-to-end path.

Use isolated preview outputs when a development plugin is running; [RELEASING.md](RELEASING.md) documents both UI and backend destinations. Keep private designs, identifiers, paths and detailed outputs out of source, review reports and archives. Share synthetic fixtures, safe screenshots and aggregate results; local `test-results/` and `releases/` are ignored.

Report findings with source location, triggering input/action, expected versus actual behavior, severity, and the smallest useful reproduction. Distinguish a defect from a disclosed unsupported PDF feature. Record which exact candidate/bundle the conclusion covers.

## Release evidence to record

Follow PDFfy's own [release workflow](RELEASING.md), not the original exporter's publishing destination. Use the newly assigned PDFfy identity `1703175034563542365`. The first beta still requires reviewed public source, a tested exact commit, hosted CI, an immutable GitHub tag/archive/checksum, Figma publication/listing verification and a Community-installed check.

Record each destination independently. Preserve published tags and archives; add subsequent publication/installed-version evidence through a documentation-only update. Until those checks finish, leave their status pending in this handoff and project memory.
