# Real Figma export fixtures

`native-links.pdf` was exported from a synthetic 600 × 400 test frame created for this project on 2026-10-27. It contains three example.com URLs in a single Inter Regular text layer. The third link wraps over three lines, giving five independent link annotations. It contains no user document content.

Source: a dedicated synthetic Figma regression file. Its private workspace link and source node identifier are omitted.

Export settings: `{ format: 'PDF', useAbsoluteBounds: true }`.

The visible letters in this PDF are vector outlines. Its nonpainting Type 3 font programs provide hidden searchable text, not a second visible text layer. PDFfy's import test compares the resulting vectors to the PDF renderer and checks that hidden text is not recreated visibly.

## PDFfy import fixtures

`pdffy-live.pdf` is a synthetic two-page PDF generated with pdf-lib for PDFfy on 2026-11-13. It contains real Helvetica text, colored rectangles, a small four-color PNG, mixed page sizes, and a 90-degree rotated second page. It contains no user document content. It is also the source of the live Figma layer-creation check.

`pdffy-beta-smoke.pdf` is the public beta smoke fixture, derived from `pdffy-live.pdf` with pdf-lib 1.17.1 on 2026-11-13. It preserves both original pages and adds two visibly labelled links in the bottom strip of page 1: `https://example.com/pdffy` and an internal destination to page 2 (`Fit`). The original fixture is unchanged. It contains only synthetic text, shapes and image data, with no private document content or workspace identifiers. Use it to check editable import, rotated/mixed page sizes, image layers, and external/internal link round trips in the installed beta.

`import-password.pdf` is a synthetic encrypted PDF used to test password retry and cancellation. Its test password is `pdffy-test`; it contains no confidential information.
