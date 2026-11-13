# PDFfy — project memory

Read this file, [README.md](README.md), [the review handoff](docs/AI-REVIEW-HANDOFF.md) and [the release workflow](docs/RELEASING.md) before changing or releasing PDFfy. Historical exporter records describe their own builds; they are not PDFfy validation results.

## Identity and current task

- Product: **PDFfy (PDF to Figma & Figma to PDF)**, a separate plugin with a direction switch.
- Public repository: [iamdbuko/PDFfy](https://github.com/iamdbuko/PDFfy).
- Released GitHub version: [**0.1.0-beta.1 prerelease**](https://github.com/iamdbuko/PDFfy/releases/tag/v0.1.0-beta.1), matching `package.json` and `package-lock.json`.
- Release source: `362cbdabe861b07f63426fe13232c41321a417b9`, tagged `v0.1.0-beta.1`. The full local beta suite passed **340/340 tests**, and [hosted CI passed for the exact release commit](https://github.com/iamdbuko/PDFfy/actions/runs/43507908772). Preserve the tag and release archive unchanged.
- Figma assigned PDFfy ID **`1703175034563542365`**, saved in `manifest.json`. The [submission](https://www.figma.com/community/plugin/1703175034563542365) was submitted for Version 1, dated November 13, 2026, but **review remains pending**. Public availability and general-user installation are not verified. Preserve this PDFfy identity; never reuse the original exporter's Community ID.
- The current task is to synchronize the latest exporter, verify the combined plugin's core features, establish its GitHub release and publish the first Figma beta. Update release status only after each destination and verification step is confirmed.

## Exporter baseline

PDFfy derives from [Figma-to-PDF with links and multiple pages](https://github.com/iamdbuko/Figma-to-PDF-with-links-and-multiple-pages). The upstream published baseline is [v9.0.2](https://github.com/iamdbuko/Figma-to-PDF-with-links-and-multiple-pages/releases/tag/v9.0.2), tag commit `2fef2bc5ff82e7fffd3b208b32d1314f78cdf4ca`. Upstream's later documentation checkpoint `132ab8f` records Community Version 11 publication and installed-version verification.

The beta preparation synchronized the final upstream `src/pdf-image-resolution.js` and `tests/pdf-image-resolution.test.js` exactly. This includes the shared-mask correction: JPEG resizing cannot claim old mask bytes as savings when another resource still retains that mask. A bounded ownership scan grants no uncertain mask savings. Keep this correction when updating import code or rebuilding bundles.

Other retained exporter helpers, assets and inherited dependency licenses match the audited baseline. `src/export-main.js` adds import routing, busy-state exclusion, suppression of selection collection during import, and the taller combined window. `src/ui.html` retains the export interface and assembly logic with the surrounding mode container and busy-state hook.

Upstream's 304-test and 148-page report evidence belongs to that exporter release. Do not present it as PDFfy's own beta test result. Link to the [upstream project memory](https://github.com/iamdbuko/Figma-to-PDF-with-links-and-multiple-pages/blob/main/PROJECT_MEMORY.md) and [upstream release evidence](https://github.com/iamdbuko/Figma-to-PDF-with-links-and-multiple-pages/blob/main/docs/releases/v9.0.2-validation.json) when describing provenance.

## Product decisions to preserve

- Keep both conversion modes mounted so changing direction retains the PDF queue and export settings. Lock mode switching during conversion, font scanning and replacement.
- Export every listed frame. Preserve frame-ID-based ordering/link targets, drag sorting, stable numeric name sorting, Remove and Clear list.
- Export defaults remain Vector, As file, 72 DPI, PNG, Lower resolution: Don't allow, Single PDF. Vector image resolution and Rasterized page resolution remain independent settings.
- Preserve native PDF text-link geometry, prototype links, mixed page sizes, RGB profiles, offline CMYK, split output, cancellation and source-edit checks. Export must not rewrite or hide source layers.
- Import files locally with previews, ranges, batch selection, passwords, page arrangements, font substitution/replacement and supported links. Editable mode creates actual supported layers; page-image mode is an explicit alternative.
- Unsupported editable effects must fail with an explanation rather than silently flatten or disappear. Import cancellation/error rolls back that job's partial section; a completed import stays committed and a late cancellation reports that truth.
- The manifest permits no network access. Do not introduce remote conversion or runtime resource dependencies. Preserve all embedded and repository license notices.

## Import limits and current corrections

PDFfy is a beta, not a claim of complete pdf.to.design PRO parity. Figma Design is the supported editor. UI limits are 128 MiB per PDF and 256 MiB queued, with additional page/image/layer/operator/payload limits documented in the README.

Text reconstruction can differ because of font availability, metrics, kerning and nonuniform scaling. Native outlined letters remain vectors; nonpainting searchable Type 3 text is omitted to prevent duplication. Painted Type 3 glyph programs and other unsupported effects are rejected in editable mode. There is no OCR, paragraph or auto-layout recovery, interactive-form reconstruction, or universal PDF fidelity guarantee.

Embedded ICC color matching is not implemented for import; PDF.js uses alternate conversion, including in previews. The exporter’s CMYK support does not imply a color-preserving CMYK/ICC round trip.

Recent beta preparation also corrected source font-weight detection and the nonrectangular clip guard. The renderer's focused suite reached 14 passing tests; this is scoped evidence, not the final combined beta suite. The UI's no-font message was corrected. Preserve these fixes and verify the rebuilt artifact.

## Source and verification

- Edit source files under `src/`; `code.js` and `ui.html` are generated by `scripts/build.mjs`.
- Use Node.js 22.13+ or 24+, pinned dependency installs, the full test suite and syntax checks. CI checks both generated runtime files and license reproducibility.
- For isolated previews, use `PDF_EXPORT_UI_OUTPUT` and `PDF_EXPORT_TEST_UI`; the build writes a matching preview backend. `PDF_EXPORT_CODE_OUTPUT` explicitly selects its destination. Do not replace a running plugin's canonical files during a native test.
- [PDFFY-VALIDATION.md](docs/PDFFY-VALIDATION.md) records the earlier 0.1.0 development-preview checkpoint. Its tests and API-bridge evidence predate the synchronized beta candidate. The beta full local suite passed 340/340 tests. The actual Desktop plugin's core flow and independently inspected saved outputs also passed; see the checkpoint below and [BETA-VALIDATION.md](docs/BETA-VALIDATION.md). Exact-commit CI and GitHub prerelease publication are verified. Figma review/public availability remain separate, pending steps.
- A successful browser simulation or Figma API-bridge layer creation does not establish the actual installed plugin's complete UI workflow. A download alone does not establish output correctness.
- Keep private designs, file IDs, detailed customer outputs, local paths and screenshots out of public source. Use synthetic fixtures and anonymized aggregate evidence. `test-results/` and `releases/` are ignored; source/release archives require an explicit contents review.

## Native beta verification checkpoint

The combined development plugin was exercised through its actual Figma Desktop interface. This supersedes the earlier API-bridge-only limitation for the covered core flow; it does not claim arbitrary-PDF or Community-installed verification.

- Editable import passed with two mixed-size pages, including rotation and grid arrangement. Font detection/remapping and invalid-range handling were exercised.
- Batch import passed with an encrypted PDF/password retry and outlined-text content; ten URL hotspots were verified.
- Page-image import at 2× produced 1,200 × 800 pixels inside a 600 × 400 frame.
- Native Undo removed only the latest import. Cancelling a 40-page import during the second page left no partial import artifacts, preserved the three preceding sections and unlocked the UI.
- Saved RGB and CMYK exports, plus raster sRGB output, were independently checked. Text-metric differences and JPEG artifacts remain documented limitations; passing structural checks does not erase those visual differences.

Detailed local round-trip and batch-link checks stay under ignored test results. The public beta validation record contains their safe aggregate findings.

## Creator-run submitted-build verification

After Figma received the submission, the creator opened the submitted build through Community's **Open in → file → Run** flow. The editable smoke import created two correctly sized/rotated pages with seven text layers, six vector layers, two images and two link hotspots: one URL and one internal target. Clicking the imported internal hotspot in Figma's prototype viewer navigated from page one to the rotated second page.

Independent inspection of the saved PDF passed: page dimensions were 360 × 240 and 180 × 280; all seven source text runs, vectors and images remained; the URL was exact; the internal PDF destination targeted the actual second page with `/Fit`. Maximum link-rectangle error was 0.00000312 pt. Both renders were reviewed with no missing content, wrong rotation, clipping or overlap. Known text-metric, JPEG and extraction-spacing differences remain documented.

This confirms the creator-access submitted build's covered behavior, not public listing availability or installation by another user. See the [publication record](docs/releases/v0.1.0-beta.1-publication.json). Figma review remains pending.

## Release and handoff

Follow [RELEASING.md](docs/RELEASING.md) for future PDFfy releases. The first beta's exact-candidate checks, GitHub prerelease and Figma submission are complete. After Figma finishes review, verify public listing access and installation by a general user; do not substitute creator-access launch evidence for that remaining check.

GitHub publication, Figma publication and installed-version verification are separate states. If one remains pending, say so. Record commit/tag, artifact hashes, CI URL, release URL, public Figma URL/version and verification scope only after confirmation. Later publication evidence belongs in a documentation-only update; do not move a published tag or silently replace its archive.
