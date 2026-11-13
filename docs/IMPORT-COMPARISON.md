# PDF import reference and acceptance targets

Researched November 13, 2026. This is a feature comparison and validation guide, not a claim that PDFfy matches every result produced by the reference plugin. No proprietary implementation was copied or inspected.

## Official reference

The [pdf.to.design documentation](https://divriots.com/pdf.to.design/docs/), updated November 2, 2026, describes these plugin capabilities:

| Capability | Documented reference behavior |
| --- | --- |
| Import choice | Editable layers or page images |
| Preview and selection | Preview pages; import all or specified ranges |
| Placement | Vertical, horizontal, or grid; a frame per page inside a section |
| Image resolution | Adjustable pixel density |
| Font handling | Detect embedded fonts, match available fonts, substitute and remap missing fonts |
| Batch import | Multiple PDFs with a paid plan |
| Passwords | Prompt during import |
| Editors | Design, FigJam, Slides, Buzz |
| Free limits | Five editable imports, first three pages; unlimited image imports |
| Size limits | Free editable imports: 500 MB; paid: up to 10 GB |

Current documentation describes API processing for editable imports and local rendering for image imports. It warns that dense print documents can require cleanup. These are publisher statements, not independently measured results.

The [product page](https://divriots.com/pdf.to.design/) describes editable text runs, preserved vector geometry, extracted native Figma images, and page thumbnails. Its current pricing text counts plugin operations per import, regardless of document complexity. Live page content was newer than some search-index excerpts when researched.

The [October 2024 announcement](https://divriots.com/blog/pdf-to-design-upgrade/) advertised unlimited PRO imports, $39 yearly or $99 lifetime, and local processing. These historical terms conflict with the current API-based documentation and subscription branding. Do not present those old terms as current.

No official promise was found for OCR, retained interactive forms, bookmarks, hyperlink import, reconstruction of auto layout, or identical fidelity for every PDF. These are separate requirements or unknowns.

## PDFfy acceptance targets

The combined plugin should keep the existing Figma-to-PDF exporter and add a mode switch. Evaluate import using the actual built plugin, not only helper functions:

- Choose one or several PDFs; show readable filenames and page counts.
- Preview content and select individual pages or ranges.
- Import selected pages with vertical, horizontal, and grid placement.
- Provide image and editable output with accurate labels explaining their differences.
- Preserve separately editable text, supported vector drawing, and embedded images when editable output is selected.
- Report font substitutions and unsupported drawing features. Do not describe a flattened page as fully editable.
- Accept a password only when required and clear it when the file is removed or the import ends.
- Keep progress, cancellation, errors, and switching modes coherent.
- Maintain the existing export settings and output behavior.

Each target needs test evidence. A passing synthetic fixture does not establish universal parity or production readiness.

## Current implementation and evidence

This table describes the development build, not a published Community release. Automated tests use real PDF parsing and rendering; Figma transport tests use a controlled API double. A small synthetic import has also created native text, vectors, and image layers through the actual Figma API. That check is narrower than running every workflow through an installed development plugin.

| Area | PDFfy status and verification boundary |
| --- | --- |
| Mode switch and existing exporter | Implemented. Browser tests retain export settings across switching and prevent switching during active work. |
| Multiple files, previews, ranges, grid options | Implemented. Browser tests exercise real files, selected-page content, names, ordering, and layout requests; controller tests verify placement. |
| Page images and density | Implemented. Browser tests decode the resulting PNG and check its pixel dimensions. |
| Editable text | Implemented for supported text. Helvetica, placement, rotation, and font descriptors are exercised with real PDFs. Arbitrary fonts and glyph spacing are not guaranteed. |
| Vectors, images, gradients | A supported subset is implemented and covered by real-PDF tests. Unsupported effects produce an explicit error and suggest image mode. |
| Outlined native Figma text | Preserved as editable vector paths. Invisible search overlays stay invisible; these outlines do not become font-editable text. A pixel comparison checks the native fixture's appearance. |
| Font matching and replacements | Implemented; parser and controller tests cover detection, substitution, remapping, and recovery. Fonts available on a particular user's machine still need real-file review. |
| Passwords | Implemented; an encrypted fixture tests incorrect-password retry and cancellation. |
| Hyperlinks | Supported URL and included-page destinations are implemented; parser and controller tests cover coordinates, target mapping, and unsupported targets. |
| Cancellation and file cleanup | Implemented; browser/controller tests cover acknowledgement, rollback, stale messages, removal, clearing, and importing again. |
| Offline processing | Bundled parser and resources. Browser import tests reject HTTP requests and assert no remote access. |
| Reference service size limits | Not matched. PDFfy's UI limits are 128 MiB per file and 256 MiB in the queue, with additional page/image/complexity limits. |
| Other editors | Not implemented: the manifest targets Figma Design only, not FigJam, Slides, or Buzz. |
| OCR, interactive forms, all-PDF fidelity | Not implemented or promised. Full commercial-plugin parity remains unverified. |

## Limits of an entirely local implementation

PDF is a drawing format rather than a copy of the source application's layers. Reconstructing fonts, clipped text, transparency groups, arbitrary color spaces, shadings, patterns, and image masks requires explicit support. Missing fonts can change line length and positioning. A scan normally contains pixels rather than recoverable editable text; OCR is a separate capability.

Browser memory and Figma node counts are real constraints. Compressed PDF size does not bound decoded image or path size. Do not reuse the reference service's 10 GB claim for PDFfy without measured support. Establish page, image-pixel, transferred-byte, and drawing-operation budgets; show actionable errors when a budget is exceeded.

Offline support must cover the parser worker, standard fonts, character maps, image decoders, and other runtime assets. A bundled entry script alone is insufficient evidence. Test with network requests blocked and assert that no HTTP requests occur.

Figma Design support does not prove FigJam, Slides, or Buzz support. Only list editor types that have been implemented and verified through their actual APIs.

## Independent verification

Use real binary PDFs, including the existing `tests/fixtures/native-links.pdf` (a synthetic Figma native export with outlined glyphs and invisible searchable text) and the sRGB/Display P3 swatch PDFs. Native text overlays must not become duplicate visible text. The synthetic `tests/fixtures/pdffy-live.pdf` contains actual Helvetica text, rectangles, embedded PNG images, mixed page sizes, and a rotated page. Add controlled PDFs covering clipping, image masks, password protection, and malformed inputs.

Run the generated `ui.html` in an isolated browser iframe with all HTTP requests rejected. Supply files through the upload control. Check the resulting page messages and dimensions, real preview pixels, content order, selected pages, and cancellation behavior. Keep parser and image rendering real; mock only the Figma message transport for this layer of testing.

Separately exercise the Figma-side import protocol and node creation. Finally run the development plugin in an actual Figma test file, inspect editable layers and font substitutions, and compare page appearance against a trusted PDF renderer. Export an imported sample through PDFfy to check the combined workflow. Record browser-only checks and real-Figma checks separately.
