# PDFfy 0.1.0 — development preview

A separate two-direction plugin built from the existing Figma-to-PDF v9.0.2 source. The original exporter remains available behind the Figma to PDF tab; the new PDF to Figma tab adds offline imports.

Includes multiple PDFs, thumbnails and ranges, editable text/vectors/images for supported content, page images with adjustable density, page layouts, passwords, font replacement/remapping, supported links, cancellation and resource limits. Original export settings and conversion features are retained.

The full automated suite passed 336 tests. Final affected interface, notice and build-isolation checks passed. Native layer creation was checked in a synthetic Figma test file through the API bridge. The combined installed desktop workflow and a full import/export round trip still need live verification.

Full commercial-plugin parity is not claimed. Figma Design only; large-file limits, complex PDF effects, font fidelity, OCR and import ICC matching remain limitations. See [validation](../PDFFY-VALIDATION.md), [comparison](../IMPORT-COMPARISON.md) and [installation](../../README.md).

This build has not been published or pushed to a remote repository. Its local plugin ID must be replaced with a new Figma-assigned ID before Community publication.
