/* PDFfy PDF import controller. No PDF parsing runs in the Figma sandbox. */
function createPdfImportController(figma, options = {}) {
  const LIMITS = Object.freeze({ pages: 10000, side: 16384, extent: 1000000, elements: 20000, text: 2000000, svg: 32 * 1024 * 1024, image: 64 * 1024 * 1024 });
  const CANCELLED = new Error('Import stopped.');
  let active = null, availableFonts = null, remapping = null, lastImport = null;
  const usedIds = new Set(), completedJobs = new Map(), loadedFonts = new Map();
  const post = message => figma.ui.postMessage(message);
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const finite = (value, label, min, max) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}.`);
    return value;
  };
  const integer = (value, label, min, max) => {
    finite(value, label, min, max);
    if (!Number.isInteger(value)) throw new Error(`${label} must be a whole number.`);
    return value;
  };
  const name = (value, fallback) => typeof value === 'string' && value.trim() ? value.slice(0, 240) : fallback;
  const normalize = value => String(value || '').replace(/^[A-Z]{6}\+/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const fontKey = font => `${font.family}\u0000${font.style}`;
  const replacement = (map, family, style) => map[`${family}|${style}`] || map[`${family} / ${style}`] || map[family];
  const warning = (job, message) => { if (job.warnings.size < 100) job.warnings.add(message); };
  const alive = job => active === job && !job.cancelled;
  const check = job => {
    if (job.remap ? remapping !== job : !alive(job)) throw CANCELLED;
    if (figma.currentPage !== job.page || job.section.removed) throw new Error('The destination page changed or the import section was removed. Start the import again.');
  };
  function own(job, node) { job.created.push(node); return node; }
  function rollback(job) {
    job.cancelled = true;
    for (let i = job.created.length - 1; i >= 0; i--) {
      const node = job.created[i];
      try { if (!node.removed) node.remove(); } catch (_) { /* A user can remove nodes while importing. */ }
    }
    job.created = [];
    if (active === job) active = null;
  }
  function fail(job, error) {
    if (!alive(job)) return;
    rollback(job);
    post({ type: 'import-error', jobId: job.id, error: error.message || String(error) });
  }
  async function fonts() {
    if (!availableFonts) {
      availableFonts = Promise.resolve(figma.listAvailableFontsAsync()).then(list => list.map(item => item.fontName || item)
        .filter(font => typeof font.family === 'string' && typeof font.style === 'string')
        .map(font => ({ family: font.family, style: font.style })));
      availableFonts.catch(() => { availableFonts = null; });
    }
    return availableFonts;
  }
  async function loadFont(font) {
    const key = fontKey(font);
    if (!loadedFonts.has(key)) loadedFonts.set(key, Promise.resolve(figma.loadFontAsync(font)).catch(error => { loadedFonts.delete(key); throw error; }));
    await loadedFonts.get(key);
    return font;
  }
  async function resolveFont(job, text) {
    const all = await fonts(); check(job);
    const sourceFamily = name(text.fontFamily, 'Inter'), sourceStyle = name(text.fontStyle, 'Regular');
    const mapping = replacement(job.fontMap, sourceFamily, sourceStyle);
    const wanted = mapping && typeof mapping === 'object' ? mapping : { family: sourceFamily, style: sourceStyle };
    const family = normalize(wanted.family), style = normalize(wanted.style || 'Regular');
    const aliases = { helvetica: ['arial', 'inter'], helveticaneue: ['arial', 'inter'], timesroman: ['timesnewroman', 'times'], times: ['timesnewroman'], courier: ['couriernew'], sansserif: ['inter', 'arial'], serif: ['timesnewroman'], monospace: ['couriernew'] };
    let match = all.find(font => normalize(font.family) === family && normalize(font.style) === style);
    if (!match) match = all.find(font => normalize(font.family + font.style) === family + style || normalize(font.family + font.style) === family);
    if (!match) match = all.find(font => normalize(font.family) === family && ['regular', 'normal', 'book', 'roman'].includes(normalize(font.style)));
    if (!match) for (const alias of aliases[family] || []) {
      match = all.find(font => normalize(font.family) === alias && normalize(font.style) === style)
        || all.find(font => normalize(font.family) === alias && normalize(font.style) === 'regular');
      if (match) break;
    }
    const fallback = all.find(font => normalize(font.family) === 'inter' && normalize(font.style) === 'regular')
      || all.find(font => normalize(font.family) === 'arial' && normalize(font.style) === 'regular') || all[0];
    if (!match) match = fallback;
    if (!match) throw new Error('No editable fonts are available in this Figma file.');
    try { await loadFont(match); } catch (error) {
      check(job);
      if (!fallback || fontKey(fallback) === fontKey(match)) throw new Error(`Could not load ${match.family} ${match.style}. Choose another font and retry.`);
      match = await loadFont(fallback);
    }
    check(job);
    if (normalize(match.family) !== normalize(sourceFamily) || normalize(match.style) !== normalize(sourceStyle)) {
      warning(job, `${sourceFamily} ${sourceStyle} → ${match.family} ${match.style}${mapping ? ' (chosen replacement)' : ' (font substitution)'}. Text spacing may differ.`);
    }
    return { font: match, sourceFamily, sourceStyle };
  }
  function validateSvg(svg) {
    if (typeof svg !== 'string' || !/<svg[\s>]/i.test(svg)) throw new Error('The page contains invalid SVG drawing data.');
    if (/<(?:script|foreignObject)\b|<!ENTITY|@import|javascript:/i.test(svg)) throw new Error('The page contains unsupported SVG content.');
    for (const match of svg.matchAll(/(?:href|xlink:href)\s*=\s*["']([^"']*)["']/gi)) {
      if (!/^(?:#|data:image\/(?:png|jpeg|jpg|gif|webp);base64,)/i.test(match[1])) throw new Error('External SVG resources are not supported.');
    }
    return svg;
  }
  function validatePage(message) {
    finite(message.width, 'Page width', 0.01, LIMITS.side); finite(message.height, 'Page height', 0.01, LIMITS.side);
    let elements;
    if (message.elements !== undefined) {
      if (!Array.isArray(message.elements)) throw new Error('Page layers must be an array.');
      elements = message.elements;
    } else {
      if (message.texts !== undefined && !Array.isArray(message.texts)) throw new Error('Page text must be an array.');
      elements = [...(message.svg ? [{ type: 'svg', svg: message.svg }] : []), ...(message.texts || []).map(item => ({ ...item, type: 'text' }))];
    }
    if (elements.length > LIMITS.elements) throw new Error('This page has too many layers. Import this page as an image.');
    let textSize = 0, svgSize = 0;
    for (const item of elements) {
      if (!item || !['svg', 'text'].includes(item.type)) throw new Error('The page contains an unsupported layer type.');
      if (item.type === 'svg') { validateSvg(item.svg); svgSize += item.svg.length; continue; }
      if (typeof item.text !== 'string') throw new Error('An editable text layer has no text.');
      textSize += item.text.length;
      finite(item.x, 'Text x position', -LIMITS.extent, LIMITS.extent); finite(item.y, 'Text y position', -LIMITS.extent, LIMITS.extent);
      finite(item.fontSize, 'Font size', 0.01, 10000);
      if (item.width !== undefined) finite(item.width, 'Text width', 0, LIMITS.extent);
      if (item.height !== undefined) finite(item.height, 'Text height', 0, LIMITS.extent);
      if (item.rotation !== undefined) finite(item.rotation, 'Text rotation', -360000, 360000);
      if (item.opacity !== undefined) finite(item.opacity, 'Text opacity', 0, 1);
      if (item.color !== undefined) for (const channel of ['r', 'g', 'b']) finite(item.color[channel], `Text ${channel} color`, 0, 1);
      if (item.transform !== undefined) {
        if (!Array.isArray(item.transform) || item.transform.length !== 2 || item.transform.some(row => !Array.isArray(row) || row.length !== 3)) throw new Error('Text transform must be a 2 × 3 matrix.');
        for (const row of item.transform) for (const value of row) finite(value, 'Text transform', -LIMITS.extent, LIMITS.extent);
        const [[a, c], [b, d]] = item.transform;
        if (Math.abs(a * d - b * c) < 1e-8) throw new Error('Text transform is degenerate. Import this page as an image.');
      }
    }
    if (textSize > LIMITS.text || svgSize > LIMITS.svg) throw new Error('This page contains too much drawing data. Import this page as an image.');
    const bytes = message.imageBytes;
    if (bytes !== undefined && (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > LIMITS.image)) throw new Error('Invalid or oversized page image.');
    if (bytes && elements.length) throw new Error('Choose either editable layers or a page image.');
    if (message.links !== undefined && (!Array.isArray(message.links) || message.links.length > 10000)) throw new Error('Invalid page hyperlinks.');
    return elements;
  }
  function positionPage(job, frame) {
    const padding = 32;
    if (job.layout === 'grid' && job.frames.length && job.frames.length % job.columns === 0) { job.x = 0; job.y += job.rowHeight + job.gap; job.rowHeight = 0; }
    const x = job.x + padding, y = job.y + padding;
    finite(x + frame.width + padding, 'Imported layout width', 1, LIMITS.extent);
    finite(y + frame.height + padding, 'Imported layout height', 1, LIMITS.extent);
    frame.x = x; frame.y = y;
    job.maxX = Math.max(job.maxX, x + frame.width + padding); job.maxY = Math.max(job.maxY, y + frame.height + padding);
    if (job.layout === 'vertical') job.y += frame.height + job.gap;
    else { job.x += frame.width + job.gap; job.rowHeight = Math.max(job.rowHeight, frame.height); }
    job.section.resizeWithoutConstraints(job.maxX, job.maxY);
  }
  async function addText(job, frame, item) {
    if (!item.text) return;
    const resolved = await resolveFont(job, item); check(job);
    const node = own(job, figma.createText()); frame.appendChild(node);
    node.name = name(item.text.replace(/\s+/g, ' '), 'Text');
    node.fontName = resolved.font;
    node.fontSize = Math.max(1, item.fontSize);
    node.textAutoResize = 'WIDTH_AND_HEIGHT';
    node.characters = item.text;
    node.fills = [{ type: 'SOLID', color: item.color || { r: 0, g: 0, b: 0 } }];
    node.opacity = item.opacity === undefined ? 1 : item.opacity;
    if (item.letterSpacing !== undefined) node.letterSpacing = { value: finite(item.letterSpacing, 'Letter spacing', -1000, 10000), unit: 'PIXELS' };
    if (item.lineHeight !== undefined) node.lineHeight = { value: finite(item.lineHeight, 'Line height', 0.01, 10000), unit: 'PIXELS' };
    if (item.width > 0 && node.width > 0 && item.text.length > 1 && !item.text.includes('\n')) {
      // PDF runs encode advance widths. Track toward that width without changing font size.
      const spacing = (item.width - node.width) / (Array.from(item.text).length - 1);
      if (Number.isFinite(spacing) && Math.abs(spacing) <= node.fontSize * 2) node.letterSpacing = { unit: 'PIXELS', value: (item.letterSpacing || 0) + spacing };
      else warning(job, 'Some text run widths could not be matched exactly with the available fonts.');
    }
    const angle = (item.rotation || 0) * Math.PI / 180;
    if (item.fontSize < 1) warning(job, 'Text smaller than 1 px was enlarged to Figma’s minimum editable font size.');
    if (item.transform) {
      const [[a, c, x], [b, d, y]] = item.transform;
      const horizontal = Math.hypot(a, b), vertical = Math.hypot(c, d);
      // Figma transforms require unit axes. Width fitting above uses PDF world
      // advance, retaining rotation/skew here without applying scale twice.
      node.relativeTransform = [[a / horizontal, c / vertical, x], [b / horizontal, d / vertical, y]];
      if (Math.abs(horizontal - vertical) > 0.0001) warning(job, 'Horizontally scaled PDF text was fitted with letter spacing. Individual letter shapes may differ.');
    } else node.relativeTransform = [[Math.cos(angle), -Math.sin(angle), item.x], [Math.sin(angle), Math.cos(angle), item.y]];
    job.texts.push({ node, sourceFamily: resolved.sourceFamily, sourceStyle: resolved.sourceStyle, width: item.width });
    if (typeof node.setPluginData === 'function') {
      node.setPluginData('pdffy-source-font', JSON.stringify({ family: resolved.sourceFamily, style: resolved.sourceStyle }));
      node.setPluginData('pdffy-imported-text', '1');
    }
  }
  async function addLinks(job, frame, links) {
    for (const item of links || []) {
      check(job);
      if (!item || typeof item !== 'object') { warning(job, 'An invalid PDF link was omitted.'); continue; }
      const url = typeof item.url === 'string' && /^(?:https?:|mailto:|tel:)/i.test(item.url.trim()) ? item.url.trim() : null;
      const destination = Number.isInteger(item.destinationPageIndex) ? item.destinationPageIndex : null;
      if (!url && destination === null) { warning(job, 'An unsupported PDF link was omitted.'); continue; }
      try {
        finite(item.x, 'Link x', -LIMITS.side, LIMITS.side); finite(item.y, 'Link y', -LIMITS.side, LIMITS.side);
        finite(item.width, 'Link width', 0.01, LIMITS.side); finite(item.height, 'Link height', 0.01, LIMITS.side);
      } catch (_) { warning(job, 'An invalid PDF link rectangle was omitted.'); continue; }
      const node = own(job, figma.createRectangle()); frame.appendChild(node);
      node.name = url ? `Link · ${url.slice(0, 80)}` : `Link · page ${destination + 1}`;
      node.resize(item.width, item.height); node.x = item.x; node.y = item.y; node.fills = []; node.strokes = [];
      if (url) await node.setReactionsAsync([{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'URL', url }] }]);
      else job.links.push({ node, destination });
      check(job);
    }
  }
  async function page(job, message) {
    if (message.pageIndex >= 0 && message.pageIndex < job.nextIndex && Number.isInteger(message.pageIndex)) {
      post({ type: 'import-page-ack', jobId: job.id, pageIndex: message.pageIndex }); return;
    }
    if (job.processing) { fail(job, new Error('Received overlapping page data. Start the import again.')); return; }
    job.processing = true;
    try {
      check(job);
      integer(message.pageIndex, 'Page index', 0, job.totalPages - 1);
      if (message.pageIndex !== job.nextIndex) throw new Error('PDF pages arrived out of order. Start the import again.');
      const elements = validatePage(message);
      const frame = own(job, figma.createFrame()); job.section.appendChild(frame);
      frame.name = name(message.name, `Page ${message.pageIndex + 1}`);
      frame.resize(message.width, message.height); frame.clipsContent = true;
      frame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
      if (message.imageBytes) {
        const image = figma.createImage(message.imageBytes);
        const node = own(job, figma.createRectangle()); frame.appendChild(node);
        node.name = 'Page image'; node.resize(message.width, message.height); node.x = 0; node.y = 0;
        node.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }]; node.strokes = [];
      } else {
        for (let i = 0; i < elements.length; i++) {
          check(job);
          const item = elements[i];
          if (item.type === 'text') await addText(job, frame, item);
          else {
            const node = own(job, figma.createNodeFromSvg(item.svg)); frame.appendChild(node);
            node.name = name(item.name, 'PDF artwork'); node.x = 0; node.y = 0;
          }
          if (i % 25 === 24) { await tick(); check(job); }
        }
      }
      await addLinks(job, frame, message.links); check(job);
      for (const note of Array.isArray(message.warnings) ? message.warnings : []) if (typeof note === 'string') warning(job, note.slice(0, 1000));
      positionPage(job, frame); job.frames.push(frame); job.nextIndex++;
      post({ type: 'import-page-ack', jobId: job.id, pageIndex: message.pageIndex, frameId: frame.id, warnings: [...job.warnings] });
    } catch (error) { if (error !== CANCELLED) fail(job, error); }
    finally { job.processing = false; }
  }
  async function finish(job) {
    if (job.processing || job.finishing) { fail(job, new Error('Wait for the current page before finishing the import.')); return; }
    job.finishing = true;
    try {
      check(job);
      if (job.nextIndex !== job.totalPages) throw new Error('Not every selected PDF page has arrived. Start the import again.');
      for (const link of job.links) {
        check(job);
        const destination = job.frames[link.destination];
        if (!destination) { if (!link.node.removed) link.node.remove(); warning(job, 'A link to a page outside this import was omitted.'); continue; }
        await link.node.setReactionsAsync([{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: destination.id, navigation: 'NAVIGATE', transition: null, preserveScrollPosition: false }] }]);
      }
      check(job);
      figma.currentPage.selection = [job.section];
      figma.viewport.scrollAndZoomIntoView([job.section]);
      if (typeof figma.commitUndo === 'function') figma.commitUndo();
      lastImport = { id: job.id, page: job.page, section: job.section, texts: job.texts };
      completedJobs.set(job.id, job.frames.length);
      active = null;
      post({ type: 'import-complete', jobId: job.id, pageCount: job.frames.length, sectionId: job.section.id, frameIds: job.frames.map(frame => frame.id), warnings: [...job.warnings] });
      job.created = [];
    } catch (error) { if (error !== CANCELLED) fail(job, error); }
  }
  function start(message) {
    const id = message.jobId;
    try {
      if (typeof id !== 'string' || !id || id.length > 160) throw new Error('A valid import job ID is required.');
      if (active || remapping || options.isExportBusy?.()) throw new Error('Another import or export is running. Wait for it to finish.');
      if (usedIds.has(id)) throw new Error('This import ID was already used. Start a new import.');
      integer(message.totalPages, 'Number of pages', 1, LIMITS.pages);
      const layout = message.layout || 'vertical';
      if (!['vertical', 'horizontal', 'grid'].includes(layout)) throw new Error('Choose a supported page arrangement.');
      const gap = message.gap === undefined ? 40 : finite(message.gap, 'Page gap', 0, 2000);
      const columns = message.columns === undefined ? 3 : integer(message.columns, 'Grid columns', 1, 100);
      usedIds.add(id);
      const section = figma.createSection();
      const job = active = { id, page: figma.currentPage, section, created: [section], frames: [], links: [], texts: [], warnings: new Set(), cancelled: false, processing: false, nextIndex: 0, totalPages: message.totalPages, layout, gap, columns, x: 0, y: 0, rowHeight: 0, maxX: 1, maxY: 1, fontMap: message.fontMap && typeof message.fontMap === 'object' ? message.fontMap : {} };
      try {
        section.name = name(message.sectionName, 'PDFfy import');
        section.x = Math.round(figma.viewport.center.x); section.y = Math.round(figma.viewport.center.y);
        section.resizeWithoutConstraints(64, 64);
        post({ type: 'import-ready', jobId: id });
      } catch (error) { fail(job, error); }
    } catch (error) { post({ type: 'import-error', jobId: id, error: error.message || String(error) }); }
  }
  async function remap(message) {
    const response = { type: 'import-remapped', requestId: message.requestId, count: 0, warnings: [] };
    let job, changes = [];
    try {
      if (active || remapping || options.isExportBusy?.()) throw new Error('Wait for the current import or export before replacing fonts.');
      if (!lastImport || lastImport.section.removed) throw new Error('Complete an editable import before replacing its fonts.');
      const map = message.fontMap;
      if (!map || typeof map !== 'object') throw new Error('Choose at least one replacement font.');
      job = remapping = { ...lastImport, remap: true, fontMap: map, warnings: new Set() };
      check(job);
      const planned = [];
      for (const record of job.texts) {
        const node = record.node;
        if (node.removed || !replacement(map, record.sourceFamily, record.sourceStyle)) continue;
        if (!node.fontName || typeof node.fontName.family !== 'string') { warning(job, 'A text layer with mixed fonts was left unchanged.'); continue; }
        const previousFont = node.fontName, previousText = node.characters;
        const resolved = await resolveFont(job, { fontFamily: record.sourceFamily, fontStyle: record.sourceStyle });
        check(job);
        if (node.removed) continue;
        await loadFont(previousFont); check(job);
        planned.push({ node, font: resolved.font, previousFont, previousText });
      }
      check(job);
      // All fonts are loaded before changing any layer, so failure can restore the batch.
      for (const item of planned) {
        if (item.node.removed) continue;
        const currentFont = item.node.fontName;
        if (!currentFont || typeof currentFont.family !== 'string' || fontKey(currentFont) !== fontKey(item.previousFont) || item.node.characters !== item.previousText) {
          warning(job, 'A text layer edited during font replacement was left unchanged.'); continue;
        }
        changes.push({ node: item.node, font: item.previousFont });
        item.node.fontName = item.font;
      }
      response.count = changes.length;
      response.warnings = [...job.warnings];
      if (changes.length && typeof figma.commitUndo === 'function') figma.commitUndo();
    } catch (error) {
      for (const item of changes.reverse()) { try { if (!item.node.removed) item.node.fontName = item.font; } catch (_) {} }
      response.error = error.message || String(error);
    } finally {
      if (remapping === job) remapping = null;
      post(response);
    }
  }
  async function handleMessage(message) {
    if (!message || typeof message.type !== 'string' || !message.type.startsWith('import-')) return false;
    if (message.type === 'import-fonts-request') {
      try { post({ type: 'import-fonts', requestId: message.requestId, fonts: await fonts() }); }
      catch (error) { post({ type: 'import-fonts', requestId: message.requestId, fonts: [], error: error.message || String(error) }); }
      return true;
    }
    if (message.type === 'import-remap') { await remap(message); return true; }
    if (message.type === 'import-start') { start(message); return true; }
    const job = active;
    if (message.type === 'import-cancel') {
      if (job && message.jobId === job.id) rollback(job);
      const completed = completedJobs.has(message.jobId);
      post({ type: 'import-cancelled', jobId: message.jobId, cancelled: !completed, completed, pageCount: completedJobs.get(message.jobId) || 0 });
      return true;
    }
    if (!job || message.jobId !== job.id) return true;
    if (message.type === 'import-page') await page(job, message);
    else if (message.type === 'import-finish') await finish(job);
    return true;
  }
  return { handleMessage, isBusy: () => Boolean(active || remapping) };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { createPdfImportController };
