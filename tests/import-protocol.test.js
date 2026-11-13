const test = require('node:test');
const assert = require('node:assert/strict');
const { createPdfImportController } = require('../src/import-main.js');

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness(options = {}) {
  const messages = [], nodes = [], loaded = [], svgInputs = [], images = [];
  let counter = 0;
  function node(type) {
    const data = new Map();
    const result = { id: `${type}-${++counter}`, type, name: '', parent: null, removed: false, children: [], x: 0, y: 0, width: 100, height: 100,
      appendChild(child) {
        if (this.removed || child.removed) throw new Error('Node was removed');
        if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child);
        this.children.push(child); child.parent = this;
      },
      remove() { this.removed = true; for (const child of [...this.children]) child.remove(); if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
      resize(width, height) { this.width = width; this.height = height; },
      resizeWithoutConstraints(width, height) { this.resize(width, height); },
      setPluginData(key, value) { data.set(key, value); }, getPluginData(key) { return data.get(key) || ''; },
      async setReactionsAsync(value) { if (options.reaction) await options.reaction(result, value); result.reactions = value; }
    };
    if (type === 'TEXT') {
      let chars = '', fontSize = 12, spacing = { value: 0, unit: 'PIXELS' }, fontName = { family: 'Inter', style: 'Regular' };
      const measure = () => { result.width = Math.max(1, Array.from(chars).length * fontSize * .5 + Math.max(0, Array.from(chars).length - 1) * spacing.value); result.height = fontSize * 1.2; };
      Object.defineProperties(result, {
        characters: { get: () => chars, set: value => { chars = value; measure(); } },
        fontSize: { get: () => fontSize, set: value => { fontSize = value; measure(); } },
        letterSpacing: { get: () => spacing, set: value => { spacing = value; measure(); } },
        fontName: { get: () => fontName, set: value => { if (options.setFont) options.setFont(result, value); fontName = value; measure(); } }
      });
    }
    nodes.push(result); return result;
  }
  const page = node('PAGE'); page.selection = [];
  const figma = { currentPage: page, viewport: { center: { x: 150, y: 250 }, scrollAndZoomIntoView(value) { figma.zoomed = value; } },
    ui: { postMessage(value) { messages.push(structuredClone(value)); } },
    async listAvailableFontsAsync() { return (options.fonts || [{ family: 'Inter', style: 'Regular' }, { family: 'Arial', style: 'Regular' }, { family: 'Arial', style: 'Bold' }]).map(fontName => ({ fontName })); },
    async loadFontAsync(font) { loaded.push(font); if (options.loadFont) await options.loadFont(font); },
    createImage(bytes) { images.push(bytes); return { hash: `image-${images.length}` }; },
    createNodeFromSvg(svg) { svgInputs.push(svg); if (options.svg) options.svg(svg); const result = node('SVG'); figma.currentPage.appendChild(result); return result; },
    commitUndo() { figma.undoCount = (figma.undoCount || 0) + 1; }
  };
  for (const [method, type] of [['createSection', 'SECTION'], ['createFrame', 'FRAME'], ['createRectangle', 'RECTANGLE'], ['createText', 'TEXT']]) figma[method] = () => { const result = node(type); figma.currentPage.appendChild(result); return result; };
  const controller = createPdfImportController(figma, { isExportBusy: options.isExportBusy });
  const send = value => controller.handleMessage(value);
  const start = extra => send({ type: 'import-start', jobId: 'j1', totalPages: 1, sectionName: 'Demo PDF', ...extra });
  const addPage = extra => send({ type: 'import-page', jobId: 'j1', pageIndex: 0, name: 'Page 1', width: 600, height: 800, ...extra });
  const of = type => messages.filter(message => message.type === type);
  const alive = type => nodes.filter(value => !value.removed && (!type || value.type === type));
  return { figma, page, controller, send, start, addPage, of, alive, loaded, svgInputs, images, nodes };
}
const drawing = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><path d="M0 0L20 0L20 20Z"/></svg>';
const textRun = extra => ({ type: 'text', text: 'Hello', x: 24, y: 40, fontSize: 20, fontFamily: 'Inter', fontStyle: 'Regular', width: 58, height: 24, color: { r: .1, g: .2, b: .3 }, ...extra });

test('imports interleaved native text and SVG into sized page frames with a sequential acknowledgement', async () => {
  const h = harness(); await h.start();
  assert.equal(h.controller.isBusy(), true);
  await h.addPage({ elements: [{ type: 'svg', svg: drawing }, textRun(), { type: 'svg', svg: drawing }], svg: '<bad>', texts: [textRun({ text: 'Must not duplicate' })] });
  const frame = h.alive('FRAME')[0];
  assert.deepEqual(frame.children.map(node => node.type), ['SVG', 'TEXT', 'SVG']);
  assert.equal(frame.width, 600); assert.equal(frame.height, 800); assert.equal(frame.clipsContent, true);
  assert.deepEqual([frame.x, frame.y], [32, 32]);
  const text = frame.children[1]; assert.equal(text.characters, 'Hello'); assert.equal(text.width, 58);
  assert.deepEqual(text.fills[0].color, { r: .1, g: .2, b: .3 });
  assert.deepEqual(text.relativeTransform, [[1, -0, 24], [0, 1, 40]]);
  assert.equal(h.of('import-page-ack').length, 1);
  await h.send({ type: 'import-finish', jobId: 'j1' });
  assert.equal(h.of('import-complete')[0].pageCount, 1); assert.equal(h.controller.isBusy(), false);
  assert.equal(h.page.selection[0].type, 'SECTION'); assert.equal(h.figma.undoCount, 1);
});

test('arranges varying page sizes vertically, horizontally, and in grid rows without overlap', async () => {
  for (const [layout, expected] of [['vertical', [[32, 32], [32, 142], [32, 352]]], ['horizontal', [[32, 32], [142, 32], [352, 32]]], ['grid', [[32, 32], [142, 32], [32, 242]]]]) {
    const h = harness(); await h.start({ totalPages: 3, layout, columns: 2, gap: 10 });
    await h.addPage({ pageIndex: 0, width: 100, height: 100 }); await h.addPage({ pageIndex: 1, width: 200, height: 200 }); await h.addPage({ pageIndex: 2, width: 150, height: 150 });
    assert.deepEqual(h.alive('FRAME').map(frame => [frame.x, frame.y]), expected, layout);
    const section = h.alive('SECTION')[0];
    for (const frame of section.children) { assert.ok(frame.x + frame.width <= section.width); assert.ok(frame.y + frame.height <= section.height); }
  }
});

test('image mode creates one native image fill and no editable placeholder text', async () => {
  const h = harness(); await h.start(); await h.addPage({ imageBytes: new Uint8Array([1, 2, 3]) });
  const frame = h.alive('FRAME')[0]; assert.equal(frame.children.length, 1); assert.equal(frame.children[0].fills[0].type, 'IMAGE');
  assert.equal(frame.children[0].name, 'Page image'); assert.equal(h.alive('TEXT').length, 0);
});

test('errors roll back all pages in the active import but preserve existing document content', async () => {
  const h = harness(); const existing = h.figma.createFrame();
  await h.start({ totalPages: 2 }); await h.addPage();
  await h.addPage({ pageIndex: 1, width: Infinity });
  assert.match(h.of('import-error')[0].error, /Page width/);
  assert.deepEqual(h.page.children, [existing]); assert.equal(h.controller.isBusy(), false);
  await h.send({ type: 'import-finish', jobId: 'j1' }); assert.equal(h.of('import-complete').length, 0);
});

test('cancellation during a pending font load cannot create late nodes or acknowledge a page', async () => {
  const font = deferred(); const h = harness({ loadFont: () => font.promise });
  await h.start(); const pending = h.addPage({ elements: [textRun()] });
  while (!h.loaded.length) await new Promise(resolve => setImmediate(resolve));
  await h.send({ type: 'import-cancel', jobId: 'j1' }); assert.equal(h.controller.isBusy(), false);
  await h.start({ jobId: 'j2' }); font.resolve(); await pending;
  assert.equal(h.alive('TEXT').length, 0); assert.equal(h.of('import-page-ack').length, 0); assert.equal(h.of('import-cancelled').length, 1);
  await h.addPage({ jobId: 'j2' }); assert.equal(h.of('import-page-ack')[0].jobId, 'j2');
});

test('rejects overlap, out-of-order pages, incomplete finish, and reusing job IDs', async () => {
  for (const message of [{ type: 'import-page', pageIndex: 1, width: 100, height: 100 }, { type: 'import-finish' }, { type: 'import-page', pageIndex: -1, width: 100, height: 100 }]) {
    const h = harness(); await h.start({ totalPages: 2 }); await h.send({ jobId: 'j1', ...message });
    assert.equal(h.of('import-error').length, 1); assert.equal(h.alive('SECTION').length, 0);
    await h.start(); assert.match(h.of('import-error').at(-1).error, /already used/);
  }
  const font = deferred(), h = harness({ loadFont: () => font.promise }); await h.start({ totalPages: 2 });
  const pending = h.addPage({ elements: [textRun()] }); while (!h.loaded.length) await new Promise(resolve => setImmediate(resolve));
  await h.addPage({ pageIndex: 1 }); font.resolve(); await pending;
  assert.match(h.of('import-error')[0].error, /overlapping/); assert.equal(h.alive('SECTION').length, 0);
});

test('ignores stale messages and idempotently acknowledges retried completed pages', async () => {
  const h = harness(); await h.start({ totalPages: 2 }); await h.addPage();
  await h.addPage(); assert.equal(h.alive('FRAME').length, 1); assert.equal(h.of('import-page-ack').length, 2);
  await h.send({ type: 'import-cancel', jobId: 'stale' }); await h.addPage({ jobId: 'stale', pageIndex: 1 });
  assert.equal(h.controller.isBusy(), true); assert.equal(h.alive('FRAME').length, 1);
  assert.equal(await h.send({ type: 'export-pdf' }), false);
});

test('font inventory, explicit font map, aliases, and fallback are native and reported', async () => {
  const h = harness(); await h.send({ type: 'import-fonts-request', requestId: 'fonts1' });
  assert.equal(h.of('import-fonts')[0].requestId, 'fonts1'); assert.deepEqual(h.of('import-fonts')[0].fonts[0], { family: 'Inter', style: 'Regular' });
  await h.start({ fontMap: { 'CustomFont|Regular': { family: 'Arial', style: 'Bold' } } });
  await h.addPage({ texts: [textRun({ fontFamily: 'CustomFont' }), textRun({ fontFamily: 'Helvetica' }), textRun({ fontFamily: 'Missing Typeface' })] });
  assert.deepEqual(h.alive('TEXT').map(node => node.fontName), [{ family: 'Arial', style: 'Bold' }, { family: 'Arial', style: 'Regular' }, { family: 'Inter', style: 'Regular' }]);
  const warnings = h.of('import-page-ack')[0].warnings.join(' '); assert.match(warnings, /chosen replacement/); assert.match(warnings, /font substitution/);
});

test('post-import remapping changes last imported text only, skips removed nodes, and respects busy state', async () => {
  const h = harness(); const existing = h.figma.createText(); existing.characters = 'Keep';
  await h.start(); await h.addPage({ texts: [textRun(), textRun({ text: 'Remove me' })] }); await h.send({ type: 'import-finish', jobId: 'j1' });
  const imported = h.alive('TEXT').filter(node => node !== existing); imported[1].remove();
  await h.send({ type: 'import-remap', requestId: 'remap1', fontMap: { 'Inter|Regular': { family: 'Arial', style: 'Bold' } } });
  assert.equal(h.of('import-remapped')[0].count, 1); assert.equal(h.of('import-remapped')[0].requestId, 'remap1');
  assert.equal(imported[0].fontName.family, 'Arial'); assert.equal(existing.fontName.family, 'Inter');
  await h.start({ jobId: 'j2' }); await h.send({ type: 'import-remap', requestId: 'busy', fontMap: {} });
  assert.match(h.of('import-remapped').at(-1).error, /Wait for/); assert.equal(h.controller.isBusy(), true);
});

test('rejects active export and malformed payloads before retaining import layers', async () => {
  const busy = harness({ isExportBusy: () => true }); await busy.start(); assert.match(busy.of('import-error')[0].error, /Another/); assert.equal(busy.alive('SECTION').length, 0);
  const bad = [
    { width: 20000 }, { elements: [textRun({ opacity: 2 })] },
    { svg: '<svg><script>alert(1)</script></svg>' }, { svg: '<svg><image href="https://example.com/image.png"/></svg>' },
    { texts: [textRun({ x: NaN })] }, { imageBytes: new Uint8Array([1]), texts: [textRun()] }, { imageBytes: [] }
  ];
  for (const payload of bad) {
    const h = harness(); await h.start(); await h.addPage(payload); assert.equal(h.of('import-error').length, 1, JSON.stringify(payload)); assert.equal(h.alive('SECTION').length, 0);
  }
});

test('page change and SVG creation failure roll back rather than leave partial imports', async () => {
  const h = harness(); await h.start(); h.figma.currentPage = { children: [] }; await h.addPage();
  assert.match(h.of('import-error')[0].error, /destination page changed/); assert.equal(h.alive('SECTION').length, 0);
  const failing = harness({ svg() { throw new Error('SVG unsupported'); } }); await failing.start(); await failing.addPage({ svg: drawing });
  assert.match(failing.of('import-error')[0].error, /SVG unsupported/); assert.equal(failing.alive('FRAME').length, 0);
});

test('preserves safe URL and selected-page links while omitting unsupported destinations', async () => {
  const h = harness(); await h.start({ totalPages: 2 });
  const rect = { x: 10, y: 20, width: 60, height: 20 };
  await h.addPage({ links: [{ ...rect, url: 'https://example.com' }, { ...rect, destinationPageIndex: 1 }, { ...rect, destinationPageIndex: 99 }, { ...rect, url: 'javascript:alert(1)' }] });
  await h.addPage({ pageIndex: 1 }); await h.send({ type: 'import-finish', jobId: 'j1' });
  const nodes = h.alive('RECTANGLE'); assert.equal(nodes.length, 2);
  assert.equal(nodes[0].reactions[0].actions[0].url, 'https://example.com'); assert.equal(nodes[1].reactions[0].actions[0].destinationId, h.alive('FRAME')[1].id);
  assert.match(h.of('import-complete')[0].warnings.join(' '), /outside this import/);
});

test('normalizes Figma transform axes and fits world text advance without applying horizontal scale twice', async () => {
  const h = harness(); await h.start();
  await h.addPage({ texts: [textRun({ width: 100, transform: [[2, 0, 24], [0, 1, 40]] }), textRun({ text: 'Tiny', fontSize: .5, width: 1 })] });
  const [wide, tiny] = h.alive('TEXT');
  assert.deepEqual(wide.relativeTransform, [[1, 0, 24], [0, 1, 40]]);
  assert.equal(wide.width, 100, 'the fitted width is the world advance, with unit transform axes');
  assert.equal(tiny.fontSize, 1); assert.equal(Math.hypot(tiny.relativeTransform[0][0], tiny.relativeTransform[1][0]), 1);
  assert.match(h.of('import-page-ack')[0].warnings.join(' '), /Individual letter shapes may differ/);
  assert.match(h.of('import-page-ack')[0].warnings.join(' '), /minimum editable font size/);
});

test('cancellation acknowledgement distinguishes rolled-back, failed, and already-committed jobs', async () => {
  const h = harness(); await h.start(); await h.addPage(); await h.send({ type: 'import-finish', jobId: 'j1' });
  await h.send({ type: 'import-cancel', jobId: 'j1' });
  assert.deepEqual(h.of('import-cancelled').at(-1), { type: 'import-cancelled', jobId: 'j1', cancelled: false, completed: true, pageCount: 1 });
  assert.equal(h.alive('FRAME').length, 1);
  await h.start({ jobId: 'j2' }); await h.addPage({ jobId: 'j2' }); await h.send({ type: 'import-cancel', jobId: 'j2' });
  assert.equal(h.of('import-cancelled').at(-1).cancelled, true); assert.equal(h.alive('FRAME').length, 1);
  await h.start({ jobId: 'j3' }); await h.addPage({ jobId: 'j3', width: NaN }); await h.send({ type: 'import-cancel', jobId: 'j3' });
  assert.equal(h.of('import-cancelled').at(-1).cancelled, true); assert.equal(h.alive('FRAME').length, 1);
});

test('remapping leaves text edited during font loading unchanged and releases its busy lock', async () => {
  const waiting = deferred(); let hold = false;
  const h = harness({ loadFont: font => hold && font.family === 'Arial' ? waiting.promise : Promise.resolve() });
  await h.start(); await h.addPage({ texts: [textRun(), textRun({ text: 'Second' })] }); await h.send({ type: 'import-finish', jobId: 'j1' });
  hold = true;
  const pending = h.send({ type: 'import-remap', requestId: 'r1', fontMap: { 'Inter|Regular': { family: 'Arial', style: 'Bold' } } });
  while (!h.loaded.some(font => font.family === 'Arial')) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.controller.isBusy(), true);
  h.alive('TEXT')[0].characters = 'User edited this'; waiting.resolve(); await pending;
  assert.equal(h.alive('TEXT')[0].fontName.family, 'Inter'); assert.equal(h.alive('TEXT')[1].fontName.family, 'Arial');
  assert.equal(h.of('import-remapped')[0].count, 1); assert.match(h.of('import-remapped')[0].warnings.join(' '), /edited during font replacement/);
  assert.equal(h.controller.isBusy(), false);
});

test('remapping restores earlier text fonts if a later font mutation fails', async () => {
  const h = harness({ setFont(node, font) { if (node.characters === 'Second' && font.family === 'Arial') throw new Error('Injected setter failure'); } });
  await h.start(); await h.addPage({ texts: [textRun(), textRun({ text: 'Second' })] }); await h.send({ type: 'import-finish', jobId: 'j1' });
  await h.send({ type: 'import-remap', requestId: 'r1', fontMap: { 'Inter|Regular': { family: 'Arial', style: 'Bold' } } });
  assert.deepEqual(h.alive('TEXT').map(node => node.fontName.family), ['Inter', 'Inter']);
  assert.match(h.of('import-remapped')[0].error, /Injected setter failure/); assert.equal(h.of('import-remapped')[0].count, 0);
  assert.equal(h.controller.isBusy(), false);
});
