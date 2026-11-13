const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { chromium } = require('@playwright/test');
const { PDFDocument, PDFName, PDFString, StandardFonts, BlendMode, rgb, degrees } = require('pdf-lib');
const { pushGraphicsState, popGraphicsState, moveTo, lineTo, closePath, clip, endPath } = require('pdf-lib');
const root = path.resolve(__dirname, '..');
let browser, bundle, fixture;

test.before(async () => {
  const built = await build({
    stdin: { contents: `import { WorkerMessageHandler } from 'pdfjs-dist/build/pdf.worker.mjs'; import * as engine from './src/pdf-import.js'; globalThis.pdfjsWorker = { WorkerMessageHandler }; globalThis.engine = engine;`, resolveDir: root },
    bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false,
    banner: { js: `if(!Promise.try)Promise.try=(fn,...args)=>new Promise(r=>r(fn(...args)));for(const T of [Map,WeakMap])if(!T.prototype.getOrInsertComputed)T.prototype.getOrInsertComputed=function(k,f){if(!this.has(k))this.set(k,f(k));return this.get(k)};if(!Uint8Array.prototype.toBase64)Uint8Array.prototype.toBase64=function(){let s='';for(let i=0;i<this.length;i+=8192)s+=String.fromCharCode(...this.subarray(i,i+8192));return btoa(s)};` }
  });
  bundle = built.outputFiles[0].text;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([400, 300]);
  page.drawRectangle({ x: 20, y: 120, width: 180, height: 100, color: rgb(0.2, 0.4, 0.8) });
  page.drawText('PDFfy editable text', { x: 30, y: 180, size: 20, font, color: rgb(1, 1, 1) });
  page.drawRectangle({ x: 28, y: 182, width: 40, height: 8, color: rgb(1, 0, 0) });
  page.drawText('Second run', { x: 30, y: 70, size: 14, font: bold, color: rgb(0.1, 0.2, 0.3) });
  const rotated = pdf.addPage([400, 300]); rotated.setRotation(degrees(90));
  rotated.drawText('Rotated', { x: 40, y: 120, size: 18, font });
  page.node.set(PDFName.of('Annots'), pdf.context.obj([
    pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [30, 60, 120, 80], A: { S: 'URI', URI: PDFString.of('https://example.com/pdffy') } })),
    pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [20, 120, 200, 220], Dest: [rotated.ref, PDFName.of('Fit')] })),
  ]));
  const embedded = await pdf.embedPng(fs.readFileSync(path.join(root, 'tests/fixtures/color-profiles/swatches-SRGB.png')));
  const imagePage = pdf.addPage([400, 300]);
  imagePage.drawImage(embedded, { x: 30, y: 40, width: 150, height: 100 });
  imagePage.drawText('Image caption', { x: 30, y: 20, size: 12, font });
  const effects = pdf.addPage([400, 300]);
  effects.drawRectangle({ x: 20, y: 20, width: 200, height: 200, color: rgb(1, 0, 0) });
  effects.drawRectangle({ x: 100, y: 100, width: 200, height: 160, color: rgb(0, 0, 1), blendMode: BlendMode.Multiply });
  fixture = await pdf.save();
  browser = await chromium.launch({ headless: true });
});
test.after(async () => browser?.close());

async function harness(t, bytes = fixture) {
  const context = await browser.newContext(); t.after(() => context.close());
  const page = await context.newPage(), requests = [], errors = [];
  await context.route(/^https?:/, route => { requests.push(route.request().url()); route.abort(); });
  page.on('pageerror', e => errors.push(e.message));
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(async bytes => { window.pdf = await engine.openPdf(Uint8Array.from(bytes)); }, Array.from(bytes));
  t.after(() => { assert.deepEqual(requests, [], 'conversion makes no HTTP requests'); assert.deepEqual(errors, []); });
  return page;
}

async function assertSvgAppearance(page, result) {
  const difference = await page.evaluate(async result => {
    const reference = await engine.renderPreview(pdf, 1, { scale: 1 });
    const load = async url => { const image = new Image(); image.src = url; await image.decode(); return image; };
    const canvas = document.createElement('canvas'); canvas.width = result.width; canvas.height = result.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(await load(reference.dataUrl), 0, 0);
    const expected = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(await load(`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(result.svg)))}`), 0, 0);
    const actual = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let total = 0;
    for (let i = 0; i < expected.length; i += 4) for (let channel = 0; channel < 3; channel++) total += Math.abs(expected[i + channel] - actual[i + channel]);
    return total / (canvas.width * canvas.height * 3);
  }, result);
  assert.ok(difference < 3, `SVG rendering differs from source by ${difference.toFixed(3)} / 255 on average`);
}

test('PDF page ranges are strict, bounded and deduplicated', async t => {
  const page = await harness(t);
  assert.deepEqual(await page.evaluate(() => engine.parsePageRange('1, 2–3, 2', 4)), [1, 2, 3]);
  assert.deepEqual(await page.evaluate(() => engine.parsePageRange('', 3)), [1, 2, 3]);
  assert.deepEqual(await page.evaluate(() => engine.parsePageRange('none', 3)), []);
  for (const range of ['0', '5', '3-1', '1,,2', '1-10000000', 'one']) {
    assert.match(await page.evaluate(range => { try { engine.parsePageRange(range, 4); } catch (e) { return e.message; } }, range), /range|numbers/i);
  }
});

test('real PDF becomes editable vectors and text in original painting order', async t => {
  const page = await harness(t);
  const result = await page.evaluate(async () => engine.convertPage(pdf, 1, { mode: 'editable' }));
  assert.equal(result.width, 400); assert.equal(result.height, 300);
  assert.deepEqual(result.elements.map(e => e.type), ['svg', 'text', 'svg', 'text']);
  assert.deepEqual(result.texts.map(e => e.text), ['PDFfy editable text', 'Second run']);
  assert.equal(result.texts[0].fontFamily, 'Helvetica');
  assert.equal(result.texts[1].fontStyle, 'Bold');
  assert.equal(result.texts[0].fontSize, 20);
  assert.equal(result.texts[0].x, 30);
  assert.ok(result.texts[0].y > 95 && result.texts[0].y < 110, `top of text: ${result.texts[0].y}`);
  assert.match(result.elements[0].svg, /<path/);
  assert.match(result.elements[2].svg, /#ff0000/);
  assert.ok(!result.svg.includes('<image'), 'an editable page is not secretly a flattened image');
});

test('page rotation is applied to dimensions and native text transform', async t => {
  const page = await harness(t);
  const result = await page.evaluate(async () => engine.convertPage(pdf, 2, { mode: 'editable' }));
  assert.equal(result.width, 300); assert.equal(result.height, 400);
  assert.equal(result.texts[0].text, 'Rotated');
  assert.ok(Math.abs(result.texts[0].rotation - 90) < 0.001);
  assert.deepEqual(result.texts[0].transform.map(row => row.slice(0, 2)), [[0, -1], [1, 0]]);
});

test('font inspection supplies stable replacement keys and respects replacement map', async t => {
  const page = await harness(t);
  const fonts = await page.evaluate(async () => engine.collectFonts(pdf, [1, 2]));
  assert.deepEqual(fonts.map(f => f.key), ['Helvetica|Regular', 'Helvetica|Bold']);
  const result = await page.evaluate(async () => engine.convertPage(pdf, 1, { fontMap: { 'Helvetica|Regular': { family: 'Inter', style: 'Medium' } } }));
  assert.equal(result.texts[0].fontFamily, 'Inter'); assert.equal(result.texts[0].fontStyle, 'Medium');
});

test('named PDF weights remain distinct in detected fonts and editable text', async t => {
  const source = await PDFDocument.create(), sourcePage = source.addPage([400, 500]);
  // Names are original synthetic descriptors; standard Helvetica glyphs supply
  // the test text. No commercial font data is bundled with this regression.
  const names = ['Inter-Medium', 'Inter-Light', 'Inter-Thin', 'Inter-SemiBoldItalic', 'Inter-ExtraBold', 'Inter-Black', 'Highlight', 'Example-DemiLight', 'Example-UltraLight', 'Example-Book'];
  for (let i = 0; i < names.length; i++) {
    const font = await source.embedFont(StandardFonts.Helvetica);
    sourcePage.drawText(`Style ${i}`, { x: 20, y: 470 - i * 30, size: 16, font });
    await font.embed();
    source.context.lookup(font.ref).set(PDFName.of('BaseFont'), PDFName.of(names[i]));
  }
  const page = await harness(t, await source.save());
  const result = await page.evaluate(async () => ({ fonts: await engine.collectFonts(pdf, [1]), converted: await engine.convertPage(pdf, 1) }));
  const expected = ['Inter|Medium', 'Inter|Light', 'Inter|Thin', 'Inter|Semi Bold Italic', 'Inter|Extra Bold', 'Inter|Black', 'Highlight|Regular', 'Example|Demi Light', 'Example|Ultra Light', 'Example|Book'];
  assert.deepEqual(result.fonts.map(font => font.key), expected);
  assert.deepEqual(result.converted.texts.map(text => `${text.fontFamily}|${text.fontStyle}`), expected);
});

test('images mode renders PNG at chosen density; preview has original page dimensions', async t => {
  const page = await harness(t);
  const result = await page.evaluate(async () => {
    const preview = await engine.renderPreview(pdf, 1, { maxWidth: 160 });
    const converted = await engine.convertPage(pdf, 1, { mode: 'image', scale: 2 });
    const image = await createImageBitmap(new Blob([converted.imageBytes], { type: 'image/png' }));
    return { preview, width: converted.width, height: converted.height, imageWidth: image.width, imageHeight: image.height, signature: Array.from(converted.imageBytes.slice(0, 8)) };
  });
  assert.equal(result.imageWidth, 800); assert.equal(result.imageHeight, 600);
  assert.equal(result.preview.width, 400); assert.equal(result.preview.height, 300);
  assert.match(result.preview.dataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(result.signature, [137, 80, 78, 71, 13, 10, 26, 10]);
});

test('invalid PDFs, cancelled jobs and excessive density produce explicit errors', async t => {
  const page = await harness(t);
  const errors = await page.evaluate(async () => {
    const capture = async fn => { try { await fn(); return null; } catch (e) { return { name: e.name, message: e.message }; } };
    const signal = AbortSignal.abort();
    return [
      await capture(() => engine.openPdf(new TextEncoder().encode('not a pdf'))),
      await capture(() => engine.convertPage(pdf, 1, { signal })),
      await capture(() => engine.convertPage(pdf, 1, { mode: 'image', scale: 10 })),
    ];
  });
  assert.match(errors[0].message, /PDF/i); assert.equal(errors[1].name, 'AbortError'); assert.match(errors[2].message, /density/);
});

test('native export outline text retains vectors without duplicating nonpainting text metadata', async t => {
  const page = await harness(t, fs.readFileSync(path.join(root, 'tests/fixtures/native-links.pdf')));
  const result = await page.evaluate(async () => engine.convertPage(pdf, 1, { mode: 'editable' }));
  assert.equal(result.width, 600); assert.equal(result.height, 400);
  assert.equal(result.texts.length, 0, 'nonpainting Type3 metadata must not become visible text');
  assert.ok(result.elements.every(e => e.type === 'svg'));
  assert.match(result.svg, /<path/); assert.ok(!result.svg.includes('<image'));
  assert.match(result.warnings.join(' '), /Outlined text.*vectors/);
  await assertSvgAppearance(page, result);
});

test('embedded PDF image remains an image layer between editable content', async t => {
  const page = await harness(t);
  const result = await page.evaluate(async () => engine.convertPage(pdf, 3, { mode: 'editable' }));
  assert.equal(result.texts[0].text, 'Image caption');
  assert.match(result.svg, /<image/); assert.match(result.svg, /data:image\/png;base64,/);
  assert.match(result.svg, /matrix\(150 0 0 100 30 160\)/);
  assert.equal(result.elements[0].type, 'svg'); assert.equal(result.elements[1].type, 'text');
});

test('native Figma color fixture preserves gradient, opacity and embedded image', async t => {
  const page = await harness(t, fs.readFileSync(path.join(root, 'tests/fixtures/color-profiles/swatches-SRGB.pdf')));
  const result = await page.evaluate(async () => engine.convertPage(pdf, 1, { mode: 'editable' }));
  assert.match(result.svg, /<linearGradient/); assert.match(result.svg, /<image/); assert.match(result.svg, /fill-opacity="0.5"/);
  assert.equal(result.texts.length, 0);
  await assertSvgAppearance(page, result);
});

test('PDF links retain clipped page coordinates and source destination page numbers', async t => {
  const page = await harness(t);
  const result = await page.evaluate(async () => engine.convertPage(pdf, 1, { mode: 'editable' }));
  assert.deepEqual(result.links, [
    { x: 30, y: 220, width: 90, height: 20, url: 'https://example.com/pdffy' },
    { x: 20, y: 80, width: 180, height: 100, destinationPageNumber: 2 },
  ]);
});

test('password-protected PDF retries incorrect passwords and can be cancelled', async t => {
  // Local original fixture: native-links.pdf, encrypted with pypdf 6.9.1 using
  // RC4-128 solely for regression coverage. Password contains no private data.
  const page = await harness(t);
  const encrypted = Array.from(fs.readFileSync(path.join(root, 'tests/fixtures/import-password.pdf')));
  const result = await page.evaluate(async bytes => {
    const reasons = [];
    const doc = await engine.openPdf(Uint8Array.from(bytes), { onPassword: reason => { reasons.push(reason); return reasons.length === 1 ? 'incorrect' : 'pdffy-test'; } });
    const count = doc.numPages; await doc.destroy();
    let cancelled;
    try { await engine.openPdf(Uint8Array.from(bytes), { onPassword: () => null }); } catch (error) { cancelled = error.message; }
    return { reasons, count, cancelled };
  }, encrypted);
  assert.deepEqual(result.reasons, [1, 2]); assert.equal(result.count, 1);
  assert.match(result.cancelled, /cancelled/i);
});

test('unsupported editable effects fail clearly while explicit image mode preserves the page', async t => {
  const page = await harness(t);
  const result = await page.evaluate(async () => {
    let error;
    try { await engine.convertPage(pdf, 4, { mode: 'editable' }); } catch (e) { error = { name: e.name, message: e.message }; }
    const image = await engine.convertPage(pdf, 4, { mode: 'image' });
    return { error, imageBytes: image.imageBytes.length };
  });
  assert.equal(result.error.name, 'UnsupportedPdfFeatureError');
  assert.match(result.error.message, /blend modes.*image/);
  assert.ok(result.imageBytes > 1000);
});

test('a diamond clip cannot be mistaken for a rectangle and leak native text', async t => {
  const source = await PDFDocument.create(), sourcePage = source.addPage([400, 400]);
  const font = await source.embedFont(StandardFonts.Helvetica);
  sourcePage.pushOperators(pushGraphicsState(), moveTo(200, 0), lineTo(400, 200), lineTo(200, 400), lineTo(0, 200), closePath(), clip(), endPath());
  sourcePage.drawText('Must stay clipped', { x: 25, y: 40, size: 20, font });
  sourcePage.pushOperators(popGraphicsState());
  const rectanglePage = source.addPage([400, 400]);
  rectanglePage.pushOperators(pushGraphicsState(), moveTo(0, 0), lineTo(400, 0), lineTo(400, 400), lineTo(0, 400), closePath(), clip(), endPath());
  rectanglePage.drawText('Inside rectangle', { x: 25, y: 40, size: 20, font });
  rectanglePage.pushOperators(popGraphicsState());
  const page = await harness(t, await source.save());
  const error = await page.evaluate(async () => {
    try { await engine.convertPage(pdf, 1, { mode: 'editable' }); return null; }
    catch (error) { return { name: error.name, message: error.message }; }
  });
  assert.equal(error?.name, 'UnsupportedPdfFeatureError');
  assert.match(error.message, /clipped text/);
  const contained = await page.evaluate(async () => engine.convertPage(pdf, 2, { mode: 'editable' }));
  assert.equal(contained.texts[0].text, 'Inside rectangle');
});
