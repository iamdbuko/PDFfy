import * as importer from './pdf-import.js';

// Independent UI lifecycle: the existing exporter keeps its settings and jobs.
globalThis.PDFfyImport = importer;
const byId = id => document.getElementById(id);
const send = message => parent.postMessage({ pluginMessage: message }, '*');
const files = [];
const fontMap = {};
const waiters = new Set();
let fonts = [], exportBusy = false, working = false, loading = false, mode = 'export';
let job = null, sequence = 0, lastImport = null, previewGeneration = 0, fontScan = null;
const MAX_FILE = 128 * 1024 * 1024, MAX_QUEUE = 256 * 1024 * 1024;

function status(text = '', error = false) {
  byId('import-status').textContent = text;
  byId('import-status').dataset.error = String(error);
}
function selectedPages(file) {
  return importer.parsePageRange(file.range, file.pdf.numPages);
}
function selectionCount() {
  try { return files.reduce((n, file) => n + selectedPages(file).length, 0); } catch { return 0; }
}
function update() {
  const busy = working || loading;
  for (const id of ['mode-import', 'mode-export']) byId(id).disabled = busy || exportBusy;
  for (const control of document.querySelectorAll('#import-mode input, #import-mode select, #import-drop, #import-clear, #import-scan-fonts, #import-remap, .import-remove, .import-preview, .import-preview-nav button')) control.disabled = busy || control.dataset.endpoint === 'true';
  const count = selectionCount();
  byId('import-start').disabled = busy || !count;
  byId('import-start').textContent = working ? 'Importing…' : count ? `Import ${count} page${count === 1 ? '' : 's'}` : 'Import';
  byId('import-cancel').hidden = !working && !fontScan;
  byId('import-cancel').disabled = Boolean(job?.signal.aborted || fontScan?.signal.aborted);
  byId('import-cancel').textContent = fontScan ? 'Cancel font scan' : job?.signal.aborted ? 'Cancelling…' : 'Cancel import';
  byId('import-clear').hidden = working || Boolean(fontScan);
  byId('import-clear').disabled = busy || !files.length;
  byId('import-drop').classList.toggle('has-files', files.length > 0);
  byId('import-drop').querySelector('strong').textContent = files.length ? '+ Add PDF files' : 'Choose PDF files';
  const image = byId('import-kind').value === 'image';
  byId('import-density-row').hidden = !image;
  byId('import-fonts').hidden = image;
  byId('import-kind-note').textContent = image ? 'Each page becomes one image layer. Text and shapes stay inside the image.' : 'Text, supported vectors and images become layers. Complex effects may require Page images.';
  byId('import-columns-row').hidden = byId('import-layout').value !== 'grid';
}
function setMode(value) {
  if (working || loading || exportBusy || !['import', 'export'].includes(value)) return;
  mode = value;
  byId('import-mode').hidden = value !== 'import';
  byId('export-mode').hidden = value !== 'export';
  byId('mode-import').setAttribute('aria-selected', String(value === 'import'));
  byId('mode-export').setAttribute('aria-selected', String(value === 'export'));
  byId('tooltip').hidden = true;
  byId('frame-context-menu').hidden = true;
  byId('quality-more-menu').hidden = true;
  if (value === 'import' && !fonts.length) send({ type: 'import-fonts-request' });
}
globalThis.PDFfyShell = { setMode, setExportBusy(value) { exportBusy = Boolean(value); update(); } };

function waitFor(type, id, pageIndex, timeout = 120000) {
  let waiter;
  const promise = new Promise((resolve, reject) => {
    waiter = { type, id, pageIndex, resolve, reject, timer: setTimeout(() => {
      waiters.delete(waiter); reject(new Error('Figma did not respond in time. Cancelled this import; try fewer pages.'));
    }, timeout) };
    waiters.add(waiter);
  });
  return promise;
}
function rejectWaiters(error) {
  for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
  waiters.clear();
}
window.addEventListener('message', event => {
  const msg = event.data?.pluginMessage;
  if (!msg?.type?.startsWith('import-')) return;
  if (msg.type === 'import-fonts') {
    fonts = (msg.fonts || []).map(font => font.fontName || font).sort((a, b) => `${a.family} ${a.style}`.localeCompare(`${b.family} ${b.style}`));
    if (msg.error) status(`Figma font list unavailable: ${msg.error}`, true);
    return;
  }
  if (msg.type === 'import-error') {
    if (msg.jobId === job?.id || [...waiters].some(w => w.id === msg.requestId)) rejectWaiters(new Error(msg.error || msg.message || 'Import failed.'));
    return;
  }
  for (const waiter of waiters) {
    if (msg.type !== waiter.type || (msg.jobId || msg.requestId) !== waiter.id || (waiter.pageIndex !== undefined && msg.pageIndex !== waiter.pageIndex)) continue;
    clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(msg);
  }
});

function requestPassword(name, reason) {
  return new Promise((resolve, reject) => {
    const dialog = byId('pdf-password-dialog'), form = byId('pdf-password-form');
    byId('pdf-password-label').textContent = `${reason === 2 ? 'Incorrect password. Try again for ' : 'Enter the password for '}${name}.`;
    byId('pdf-password').value = '';
    const done = (value, error) => {
      form.removeEventListener('submit', submit); dialog.removeEventListener('cancel', cancel);
      byId('pdf-password-cancel').removeEventListener('click', cancel); dialog.close(); byId('pdf-password').value = '';
      error ? reject(error) : resolve(value);
    };
    const submit = event => { event.preventDefault(); done(byId('pdf-password').value); };
    const cancel = event => { event.preventDefault(); done(null, new Error('Password entry cancelled.')); };
    form.addEventListener('submit', submit); dialog.addEventListener('cancel', cancel);
    byId('pdf-password-cancel').addEventListener('click', cancel); dialog.showModal(); byId('pdf-password').focus();
  });
}

async function addFiles(incoming) {
  if (working || loading) return;
  loading = true; update();
  const errors = [];
  try {
    for (const file of incoming) {
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { errors.push(`${file.name}: choose a PDF file.`); continue; }
      if (!file.size || file.size > MAX_FILE || files.reduce((n, f) => n + f.size, file.size) > MAX_QUEUE) { errors.push(`${file.name}: exceeds the local file allowance (128 MiB per file, 256 MiB total).`); continue; }
      status(`Opening ${file.name}…`);
      try {
        const pdf = await importer.openPdf(new Uint8Array(await file.arrayBuffer()), { onPassword: reason => requestPassword(file.name, reason) });
        files.push({ id: ++sequence, name: file.name, size: file.size, pdf, range: '', previewStart: 1 });
      } catch (error) { errors.push(`${file.name}: ${error.message}`); }
    }
    renderFiles();
    status(errors.join('\n'), errors.length > 0);
  } finally { loading = false; byId('import-files').value = ''; update(); }
}

function element(tag, className, text) {
  const result = document.createElement(tag); if (className) result.className = className;
  if (text !== undefined) result.textContent = text; return result;
}
function renderFiles() {
  const generation = ++previewGeneration;
  const list = byId('import-file-list'); list.replaceChildren();
  for (const file of files) {
    const card = element('article', 'import-file');
    const header = element('div', 'import-file-header');
    header.append(element('span', 'import-file-name', file.name), element('small', '', `${file.pdf.numPages} page${file.pdf.numPages === 1 ? '' : 's'}`));
    const remove = element('button', 'import-remove', '×'); remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.onclick = async () => {
      if (working || loading) return;
      const index = files.indexOf(file); if (index < 0) return;
      files.splice(index, 1); renderFiles(); update();
      try { await file.pdf.loadingTask.destroy(); } catch (error) { status(error.message, true); }
    };
    header.append(remove); card.append(header);
    const rangeRow = element('div', 'import-range-row'), label = element('label', '', 'Pages'), input = element('input');
    input.id = `pdf-range-${file.id}`; label.htmlFor = input.id; input.value = file.range; input.placeholder = 'All pages · e.g. 1–3, 5';
    const error = element('p', 'import-error'); error.hidden = true;
    input.addEventListener('input', () => {
      file.range = input.value;
      try { selectedPages(file); error.hidden = true; input.removeAttribute('aria-invalid'); }
      catch (problem) { error.textContent = problem.message; error.hidden = false; input.setAttribute('aria-invalid', 'true'); }
      refreshSelected(); update();
    });
    rangeRow.append(label, input); card.append(rangeRow, error);
    const previews = element('div', 'import-previews'); card.append(previews);
    const end = Math.min(file.pdf.numPages, file.previewStart + 11);
    for (let number = file.previewStart; number <= end; number++) {
      const button = element('button', 'import-preview pending'); button.dataset.page = number; button.setAttribute('aria-label', `Page ${number} of ${file.name}`);
      button.append(element('span', '', String(number)));
      button.onclick = () => {
        if (working || loading) return;
        let chosen; try { chosen = new Set(selectedPages(file)); } catch { chosen = new Set(); }
        chosen.has(number) ? chosen.delete(number) : chosen.add(number);
        // 'none' is an explicit empty selection, while blank means all pages.
        file.range = chosen.size ? [...chosen].sort((a, b) => a - b).join(', ') : 'none';
        input.value = file.range; error.hidden = true; input.removeAttribute('aria-invalid'); refreshSelected(); update();
      };
      previews.append(button);
    }
    function refreshSelected() {
      let selected; try { selected = new Set(selectedPages(file)); } catch { selected = new Set(); }
      for (const button of previews.children) button.setAttribute('aria-pressed', String(selected.has(Number(button.dataset.page))));
    }
    refreshSelected();
    if (file.pdf.numPages > 12) {
      const nav = element('div', 'import-preview-nav'), prev = element('button', '', '← Previous'), next = element('button', '', 'Next →');
      prev.dataset.endpoint = String(file.previewStart === 1); next.dataset.endpoint = String(end === file.pdf.numPages);
      prev.disabled = file.previewStart === 1; next.disabled = end === file.pdf.numPages;
      prev.onclick = () => { file.previewStart = Math.max(1, file.previewStart - 12); renderFiles(); update(); };
      next.onclick = () => { file.previewStart = Math.min(file.pdf.numPages, file.previewStart + 12); renderFiles(); update(); };
      nav.append(prev, element('span', '', `${file.previewStart}–${end} of ${file.pdf.numPages}`), next); card.append(nav);
    }
    list.append(card);
    // Render sequentially per document, bounded to twelve thumbnails per file.
    void (async () => {
      for (const button of previews.children) {
        if (generation !== previewGeneration) return;
        try {
          const preview = await importer.renderPreview(file.pdf, Number(button.dataset.page), { maxWidth: 160 });
          if (generation !== previewGeneration) return;
          const img = element('img'); img.alt = ''; img.src = preview.dataUrl;
          button.prepend(img); button.classList.remove('pending');
        } catch { button.title = 'Preview unavailable; try importing the page.'; }
      }
    })();
  }
}

async function scanFonts() {
  if (working || loading || !files.length) return;
  loading = true; fontScan = new AbortController(); update(); status('Detecting fonts…');
  try {
    const detected = new Map();
    for (const file of files) for (const font of await importer.collectFonts(file.pdf, selectedPages(file), { signal: fontScan.signal })) detected.set(font.key, font);
    const container = byId('import-font-maps'); container.replaceChildren();
    for (const font of detected.values()) {
      const row = element('label', 'font-map'); row.append(element('span', '', `${font.family} · ${font.style}`));
      const select = element('select'); select.setAttribute('aria-label', `Replace ${font.family} ${font.style}`);
      const auto = element('option', '', 'Automatic match'); auto.value = ''; select.append(auto);
      for (const available of fonts) {
        const option = element('option', '', `${available.family} · ${available.style}`); option.value = JSON.stringify(available); select.append(option);
      }
      select.value = fontMap[font.key] ? JSON.stringify(fontMap[font.key]) : '';
      select.onchange = () => { if (select.value) fontMap[font.key] = JSON.parse(select.value); else delete fontMap[font.key]; };
      row.append(select); container.append(row);
    }
    status(detected.size ? `${detected.size} font style${detected.size === 1 ? '' : 's'} detected. Missing fonts are reported after import.` : 'No editable text fonts found. The PDF may contain outlined text or scanned images.');
  } catch (error) { status(fontScan.signal.aborted ? 'Font scan cancelled.' : error.message, !fontScan.signal.aborted); }
  finally { loading = false; fontScan = null; update(); }
}

async function runImport() {
  if (working || loading || exportBusy) return;
  let plan;
  try { plan = files.flatMap(file => selectedPages(file).map(page => ({ file, page }))); } catch (error) { status(error.message, true); return; }
  if (!plan.length) return;
  const gap = Number(byId('import-gap').value), columns = Number(byId('import-columns').value);
  if (!Number.isFinite(gap) || gap < 0 || gap > 1000 || !Number.isInteger(columns) || columns < 1 || columns > 20) { status('Use a spacing from 0 to 1000 and 1 to 20 columns.', true); return; }
  working = true;
  const controller = new AbortController();
  const current = job = { id: `pdffy-${Date.now()}-${++sequence}`, signal: controller.signal, controller };
  const warnings = new Set(); update();
  try {
    let response = waitFor('import-ready', current.id);
    send({ type: 'import-start', jobId: current.id, layout: byId('import-layout').value, gap, columns,
      sectionName: files.length === 1 ? files[0].name.replace(/\.pdf$/i, '') : 'PDFfy · Imported PDFs', totalPages: plan.length, fontMap });
    await response;
    for (let index = 0; index < plan.length; index++) {
      current.signal.throwIfAborted();
      const { file, page } = plan[index];
      status(`Converting ${index + 1} of ${plan.length} · ${file.name}, page ${page}…`);
      const converted = await importer.convertPage(file.pdf, page, { mode: byId('import-kind').value, scale: Number(byId('import-density').value), signal: current.signal });
      current.signal.throwIfAborted();
      if (converted.links) converted.links = converted.links.flatMap(link => {
        if (link.url) return [link];
        const destinationPageIndex = plan.findIndex(target => target.file === file && target.page === link.destinationPageNumber);
        if (destinationPageIndex < 0) { warnings.add(`${file.name}, page ${page}: A link to a page outside the selected range was omitted.`); return []; }
        const { destinationPageNumber, ...rect } = link;
        return [{ ...rect, destinationPageIndex }];
      });
      for (const warning of converted.warnings || []) warnings.add(`${file.name}, page ${page}: ${warning}`);
      response = waitFor('import-page-ack', current.id, index);
      const { svg, texts, ...payload } = converted;
      // Ordered elements carry the same content without sending duplicate SVGs.
      send({ type: 'import-page', jobId: current.id, pageIndex: index, name: `${file.name.replace(/\.pdf$/i, '')} · ${page}`, ...payload,
        ...(converted.elements ? {} : { svg, texts }) });
      const ack = await response;
      for (const warning of ack.warnings || []) warnings.add(warning);
    }
    response = waitFor('import-complete', current.id);
    send({ type: 'import-finish', jobId: current.id });
    const completed = await response;
    for (const warning of completed.warnings || []) warnings.add(warning);
    lastImport = current.id; byId('import-remap').hidden = byId('import-kind').value !== 'editable';
    status(`Imported ${completed.pageCount ?? plan.length} page${plan.length === 1 ? '' : 's'} into Figma.${warnings.size ? '\n\n' + [...warnings].join('\n') : ''}`);
  } catch (error) {
    rejectWaiters(error);
    const cancellation = waitFor('import-cancelled', current.id, undefined, 10000);
    send({ type: 'import-cancel', jobId: current.id });
    try {
      const result = await cancellation;
      if (result.completed) {
        lastImport = current.id;
        byId('import-remap').hidden = byId('import-kind').value !== 'editable';
        status(`Import already completed: ${result.pageCount} pages remain in Figma.`);
      } else status(current.signal.aborted ? 'Import cancelled. Pages created by this import were removed.' : error.message, !current.signal.aborted);
    } catch {
      status(`${current.signal.aborted ? 'Cancellation requested.' : error.message} Figma has not confirmed cleanup. Check the imported section before retrying.`, true);
    }
  } finally { if (job === current) job = null; working = false; update(); }
}
async function remap() {
  if (!lastImport || working || loading) return;
  loading = true; update();
  const requestId = `font-map-${++sequence}`;
  try {
    const response = waitFor('import-remapped', requestId);
    send({ type: 'import-remap', requestId, fontMap });
    const result = await response;
    if (result.error) throw new Error(result.error);
    status(`Updated ${result.count} text layers.${result.warnings?.length ? '\n' + result.warnings.join('\n') : ''}`);
  } catch (error) { status(error.message, true); }
  finally { loading = false; update(); }
}

function initialize() {
  byId('mode-import').onclick = () => setMode('import'); byId('mode-export').onclick = () => setMode('export');
  for (const id of ['mode-import', 'mode-export']) byId(id).addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setMode(mode === 'import' ? 'export' : 'import'); byId(`mode-${mode}`).focus(); }
  });
  byId('import-drop').onclick = () => byId('import-files').click();
  byId('import-files').onchange = event => void addFiles([...event.target.files]);
  const drop = byId('import-drop');
  for (const type of ['dragenter', 'dragover']) drop.addEventListener(type, event => { event.preventDefault(); if (!working && !loading) drop.classList.add('dragover'); });
  for (const type of ['dragleave', 'drop']) drop.addEventListener(type, event => { event.preventDefault(); drop.classList.remove('dragover'); if (type === 'drop') void addFiles([...event.dataTransfer.files]); });
  byId('import-clear').onclick = async () => { if (working || loading) return; previewGeneration++; const old = files.splice(0); renderFiles(); status(); update(); await Promise.allSettled(old.map(file => file.pdf.loadingTask.destroy())); };
  byId('import-kind').onchange = update; byId('import-layout').onchange = update;
  byId('import-start').onclick = runImport;
  byId('import-cancel').onclick = () => {
    if (fontScan) { fontScan.abort(); update(); return; }
    if (!job) return;
    job.controller.abort(); rejectWaiters(new Error('Cancelled')); update();
  };
  byId('import-scan-fonts').onclick = scanFonts; byId('import-remap').onclick = remap;
  update();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize); else initialize();
