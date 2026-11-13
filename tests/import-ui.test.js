const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const nativePdf = fs.readFileSync(path.join(__dirname, 'fixtures/native-links.pdf'));
let browser;

test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });

async function harness(t, options = {}) {
  const context = await browser.newContext({ viewport: { width: 560, height: 760 } });
  t.after(() => context.close());
  const requests = [], errors = [];
  await context.route(/^https?:/, route => { requests.push(route.request().url()); return route.abort(); });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(`<style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style>
    <script>
      window.received = [];
      window.holdPages = ${Boolean(options.holdPages)};
      window.respond = message => document.querySelector('iframe').contentWindow.postMessage({ pluginMessage: message }, '*');
      addEventListener('message', event => {
        const m = event.data?.pluginMessage;
        if (!m) return;
        received.push(m);
        if (m.type === 'import-fonts-request') respond({ type: 'import-fonts', requestId: m.requestId, fonts: [{ family: 'Inter', style: 'Regular' }, { family: 'Arial', style: 'Regular' }] });
        if (m.type === 'import-start') respond({ type: 'import-ready', jobId: m.jobId });
        if (m.type === 'import-page' && !holdPages) respond({ type: 'import-page-ack', jobId: m.jobId, pageIndex: m.pageIndex, frameId: 'test-frame-' + m.pageIndex, warnings: [] });
        if (m.type === 'import-finish') respond({ type: 'import-complete', jobId: m.jobId, pageCount: received.filter(x => x.type === 'import-page' && x.jobId === m.jobId).length, frameIds: ['test-frame-0'], warnings: [] });
        if (m.type === 'import-cancel') respond({ type: 'import-cancelled', jobId: m.jobId, cancelled: true, completed: false, pageCount: 0 });
      });
    </script><iframe title="PDFfy test UI"></iframe>`);
  const frame = page.frames()[1];
  await frame.setContent(fs.readFileSync(process.env.PDF_EXPORT_TEST_UI || path.join(root, 'ui.html'), 'utf8'));
  await frame.waitForFunction(() => Boolean(window.PDFfyShell && window.PDFfyImport), {}, { timeout: 15000 });
  const post = message => page.evaluate(message => respond(message), message);
  const messages = type => page.evaluate(type => received.filter(message => message.type === type).map(message => ({ ...message, ...(message.imageBytes ? { imageBytes: Array.from(message.imageBytes) } : {}) })), type);
  const waitMessage = async type => {
    await page.waitForFunction(type => received.some(message => message.type === type), type, { timeout: 20000 });
    return (await messages(type)).at(-1);
  };
  const load = async (buffer = nativePdf, name = 'native-links.pdf') => {
    if (await frame.locator('#mode-import').getAttribute('aria-selected') !== 'true') await frame.locator('#mode-import').click();
    await frame.locator('#import-files').setInputFiles({ name, mimeType: 'application/pdf', buffer });
    await frame.waitForFunction(() => [...document.querySelectorAll('.import-preview img')].some(img => img.complete && img.naturalWidth > 0)
      || document.querySelector('.import-preview[title]') || document.querySelector('#import-status')?.dataset.error === 'true', {}, { timeout: 20000 });
    assert.ok(await frame.locator('.import-preview img').count(), `a real preview must render: ${await frame.locator('#import-status').textContent() || await frame.locator('.import-preview').first().getAttribute('title')}`);
    await frame.locator('#import-start').waitFor({ state: 'visible' });
  };
  t.after(() => {
    assert.deepEqual(errors, [], 'the built UI must have no uncaught browser errors');
    assert.deepEqual(requests, [], 'PDF parsing, fonts and previews must not request remote assets');
  });
  return { page, frame, post, messages, waitMessage, load };
}

test('offline native PDF preview and vector import preserve outlined text without duplicating hidden search text', { timeout: 45000 }, async t => {
  const h = await harness(t);
  assert.equal(await h.frame.locator('#mode-export').getAttribute('aria-selected'), 'true');
  await h.post({ type: 'frames-updated', frames: [{ id: 'export-frame', name: 'Existing export frame', width: 600, height: 400 }], connections: [] });
  await h.frame.locator('#open-settings-btn').click();
  await h.frame.locator('[data-setting="color-profile"][data-value="SRGB"]').click();
  await h.frame.locator('label[for="export-raster"]').click();
  await h.load();
  assert.match(await h.frame.locator('#import-file-list').textContent(), /native-links\.pdf/);
  const preview = await h.frame.locator('.import-preview img').first().evaluate(img => {
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0, light = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] > 0 && pixels[i] + pixels[i + 1] + pixels[i + 2] < 450) dark++;
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 700) light++;
    }
    return { width: canvas.width, height: canvas.height, dark, light };
  });
  assert.ok(Math.abs(preview.width / preview.height - 1.5) < 0.02, 'preview retains the PDF aspect ratio within pixel rounding');
  assert.ok(preview.dark > 10 && preview.light > 10, 'preview contains the PDF text and page, not a blank placeholder');
  await h.frame.locator('#import-layout').selectOption('horizontal');
  await h.frame.locator('#import-start').click();
  const start = await h.waitMessage('import-start');
  assert.equal(start.totalPages, 1);
  assert.equal(start.layout, 'horizontal');
  const imported = await h.waitMessage('import-page');
  assert.equal(imported.width, 600);
  assert.equal(imported.height, 400);
  assert.equal(imported.imageBytes, undefined, 'editable mode must not quietly flatten the entire page');
  assert.equal(imported.elements.filter(element => element.type === 'text' && element.opacity !== 0).length, 0,
    'this native PDF paints text as outlines; its metrics-only Type 3 search overlay must not become duplicate visible text');
  assert.ok(imported.elements.some(element => element.type === 'svg' && /<path\b/.test(element.svg)), 'the actual outlined glyph artwork remains as vectors');
  assert.match(imported.warnings.join(' '), /outline|searchable|invisible/i);
  await h.waitMessage('import-finish');
  await h.frame.waitForFunction(() => !document.querySelector('#mode-export').disabled);
  await h.frame.locator('#mode-export').click();
  assert.equal(await h.frame.locator('#color-profile').inputValue(), 'SRGB');
  assert.equal(await h.frame.locator('#export-raster').isChecked(), true);
  assert.equal((await h.messages('export-pdf')).length, 0, 'switching modes must not trigger an export');
});

test('page-image import encodes the selected density without changing Figma page dimensions', { timeout: 45000 }, async t => {
  const h = await harness(t);
  await h.load();
  await h.frame.locator('#import-kind').selectOption('image');
  await h.frame.locator('#import-density').selectOption('2');
  await h.frame.locator('#import-start').click();
  const imported = await h.waitMessage('import-page');
  assert.deepEqual([imported.width, imported.height], [600, 400]);
  assert.ok(imported.imageBytes.length > 100);
  assert.deepEqual(imported.imageBytes.slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10]);
  const actual = await h.frame.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: 'image/png' }));
    const result = [bitmap.width, bitmap.height]; bitmap.close(); return result;
  }, imported.imageBytes);
  assert.deepEqual(actual, [1200, 800], 'actual decoded PNG pixels must implement 2× density');
  await h.waitMessage('import-finish');
});

test('invalid page ranges block import and a corrected range imports the requested real page', { timeout: 45000 }, async t => {
  const h = await harness(t);
  await h.load(fs.readFileSync(path.join(__dirname, 'fixtures/pdffy-live.pdf')), 'two-pages.pdf');
  const range = h.frame.locator('.import-range-row input');
  await range.fill('3');
  await range.blur();
  assert.equal(await range.getAttribute('aria-invalid'), 'true');
  assert.equal(await h.frame.locator('.import-error').isVisible(), true);
  if (await h.frame.locator('#import-start').isEnabled()) await h.frame.locator('#import-start').click();
  assert.equal((await h.messages('import-start')).length, 0);
  await range.fill('2');
  await range.blur();
  await h.frame.locator('#import-start').click();
  const imported = await h.waitMessage('import-page');
  assert.deepEqual([imported.width, imported.height], [180, 280], 'selected page dimensions include its 90-degree PDF rotation');
  const texts = imported.elements.filter(element => element.type === 'text');
  const text = texts.map(element => element.text).join(' ');
  assert.match(text, /Rotated page 90 degrees/);
  assert.doesNotMatch(text, /PDFfy editable import/);
  assert.ok(texts.every(element => Number.isFinite(element.x) && Number.isFinite(element.y) && element.fontSize > 0 && element.width > 0));
  assert.ok(imported.elements.some(element => element.type === 'svg' && /<path\b/.test(element.svg)), 'the selected page retains vector artwork');
  assert.ok(imported.elements.some(element => element.type === 'svg' && /<image\b/.test(element.svg) && /data:image\/png;base64,/.test(element.svg)), 'its embedded image is extracted separately from the editable text');
  await h.waitMessage('import-finish');
  assert.equal((await h.messages('import-page')).length, 1);
});

test('in-flight imports lock mode switching and cancellation releases the UI without finishing', { timeout: 45000 }, async t => {
  const h = await harness(t, { holdPages: true });
  await h.load();
  await h.frame.locator('#import-start').click();
  await h.waitMessage('import-page');
  assert.equal(await h.frame.locator('#mode-import').isDisabled(), true);
  assert.equal(await h.frame.locator('#mode-export').isDisabled(), true);
  await h.frame.locator('#import-cancel').click();
  await h.waitMessage('import-cancel');
  await h.frame.waitForFunction(() => !document.querySelector('#mode-export').disabled);
  assert.equal((await h.messages('import-finish')).length, 0);
  await h.frame.locator('#mode-export').click();
  assert.equal(await h.frame.locator('#mode-export').getAttribute('aria-selected'), 'true');
});

test('batch PDFs retain separate names and honor grid arrangement in one acknowledged import', { timeout: 45000 }, async t => {
  const h = await harness(t);
  await h.frame.locator('#mode-import').click();
  await h.frame.locator('#import-files').setInputFiles([
    { name: 'first-document.pdf', mimeType: 'application/pdf', buffer: nativePdf },
    { name: 'second-document.pdf', mimeType: 'application/pdf', buffer: nativePdf }
  ]);
  await h.frame.waitForFunction(() => document.querySelectorAll('.import-file').length === 2 && !document.querySelector('#import-start').disabled);
  await h.frame.locator('#import-layout').selectOption('grid');
  await h.frame.locator('#import-columns').fill('2');
  await h.frame.locator('#import-gap').fill('24');
  await h.frame.locator('#import-start').click();
  const start = await h.waitMessage('import-start');
  assert.deepEqual([start.totalPages, start.layout, start.columns, start.gap], [2, 'grid', 2, 24]);
  await h.waitMessage('import-finish');
  const pages = await h.messages('import-page');
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map(page => page.pageIndex), [0, 1]);
  assert.match(pages[0].name, /first-document/);
  assert.match(pages[1].name, /second-document/);
  for (const page of pages) assert.ok(page.elements.some(element => element.type === 'svg' && /<path\b/.test(element.svg)));
});

test('removing and clearing loaded PDFs releases their documents and allows another import', { timeout: 45000 }, async t => {
  const h = await harness(t);
  await h.load(nativePdf, 'remove-me.pdf');
  await h.load(nativePdf, 'clear-me.pdf');
  await h.frame.waitForFunction(() => document.querySelectorAll('.import-file').length === 2);
  await h.frame.getByRole('button', { name: 'Remove remove-me.pdf', exact: true }).click();
  await h.frame.waitForFunction(() => document.querySelectorAll('.import-file').length === 1);
  assert.match(await h.frame.locator('#import-file-list').textContent(), /clear-me\.pdf/);
  assert.doesNotMatch(await h.frame.locator('#import-file-list').textContent(), /remove-me\.pdf/);
  await h.frame.locator('#import-clear').click();
  await h.frame.waitForFunction(() => document.querySelectorAll('.import-file').length === 0);
  assert.equal(await h.frame.locator('#import-start').isDisabled(), true);
  assert.equal(await h.frame.locator('#import-clear').isDisabled(), true);
  await h.load(nativePdf, 'loaded-again.pdf');
  await h.frame.locator('#import-start').click();
  const page = await h.waitMessage('import-page');
  assert.match(page.name, /loaded-again/);
  assert.ok(page.elements.some(element => element.type === 'svg' && /<path\b/.test(element.svg)));
  await h.waitMessage('import-finish');
});
