# PDFfy development and release workflow

PDFfy is a separate plugin derived from Figma-to-PDF v9.0.2. The inherited exporter's release procedure is archived in [v9-exporter-releasing.md](releases/v9-exporter-releasing.md). Do not use its Community plugin ID or publishing destination for PDFfy.

## Local development

Use Node.js 22.13+ or 24+.

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm run build
node --check code.js
npm test
```

`code.js` and `ui.html` are generated. Edit `src/import-main.js`, `src/export-main.js` and the UI/helper sources, then rebuild. Runtime libraries, decoder resources and license notices are bundled for offline use. Keep their notices intact.

The manifest points to both generated files. Import it through Figma Desktop's Plugins → Development → Import plugin from manifest. Test in a synthetic design where you have editing and plugin access. PDFfy's assigned ID is `1703175034563542365`; preserve it for future updates. It is separate from the original exporter's ID. See [Figma's manifest documentation](https://developers.figma.com/docs/plugins/manifest/).

To build a preview without replacing the live plugin's backend or UI:

```sh
PDF_EXPORT_UI_OUTPUT=/tmp/pdffy-preview.html npm run build
PDF_EXPORT_TEST_UI=/tmp/pdffy-preview.html npm test
```

This writes `/tmp/pdffy-preview.html` and `/tmp/pdffy-preview.code.js`. `PDF_EXPORT_CODE_OUTPUT` can explicitly set the backend destination. Preview builds still refresh the repository's `licenses/` files. Test files that exercise backend source directly continue using the source files in this checkout. Close a running development plugin before replacing its canonical files.

## Candidate verification

- Run the complete suite against the built UI. The import tests cover real PDF parsing and rendering; Figma transport is mocked at the browser-test layer.
- In Figma Desktop, exercise the actual installed plugin: editable and image imports, a protected PDF, ranges, multiple files, layout choices, font replacement, cancellation, and the mode switch. Export an imported sample and inspect its saved PDF.
- Review text metrics, drawing order, image resolution, gradients, links and colors against the source. Native outlined text is not recoverable as editable text. Import does not perform embedded ICC color matching.
- Record covered cases and remaining failures in the validation record. Browser tests and an API bridge check do not establish the entire desktop workflow.
- When a Git repository is established, verify both generated files are reproducible:

```sh
npm run build
git diff --exit-code -- code.js ui.html licenses/
```

The GitHub Actions workflow includes this check. Confirm it passes for the exact release commit; see the release's publication record for completed runs. Inherited stress runners and historical release records describe the original exporter, not new PDFfy stress results.

## Publishing

Publishing is a separate action. Use PDFfy's assigned plugin ID, the `iamdbuko/PDFfy` repository and the exact tested release checkout. Update version numbers, screenshots, help and release notes together. Publish an immutable semantic tag and GitHub prerelease with the source ZIP and checksum. Then publish through Figma Desktop, verify the public listing and test the Community-installed plugin. Record publication evidence in a later documentation-only commit without moving the tag. Preserve the original Figma-to-PDF project and release identity.

If Figma places a new plugin in review, record the submission receipt and private listing status separately from public availability. A creator-run submitted build can be tested through the listing, but does not prove general-user installation. Finish that check once Figma approves the submission.
