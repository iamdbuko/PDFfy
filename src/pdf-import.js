import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';

// Conversion deliberately uses the pinned PDF.js display operators. Unknown
// drawing operations stop editable conversion instead of disappearing from it.
const { OPS } = pdfjs;
const IDENTITY = [1, 0, 0, 1, 0, 0];
export const IMPORT_LIMITS = Object.freeze({ maxFileBytes: 256 * 1024 * 1024, maxPageSide: 16384, maxImageSide: 4096, maxImagePixels: 16 * 1024 * 1024, maxOperators: 250000, maxElements: 10000 });

function abort(signal) {
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
}
function tick() { return new Promise(resolve => setTimeout(resolve, 0)); }
function bytesFromBase64(value) {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
class OfflineBinaryDataFactory {
  async fetch({ kind, filename }) {
    const folder = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' }[kind];
    const data = globalThis.PDFfyAssets?.[folder]?.[filename];
    if (!data) throw new Error(`The bundled PDF resource ${filename} is unavailable.`);
    return bytesFromBase64(data);
  }
}

/** Load local bytes only. The optional password callback receives PDF.js's
 * NEED_PASSWORD (1) or INCORRECT_PASSWORD (2), and returns a password or null. */
export async function openPdf(bytes, options = {}) {
  if (typeof options === 'function') options = { onPassword: options };
  abort(options.signal);
  const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
  if (!data.byteLength) throw new Error('This PDF is empty.');
  if (data.byteLength > IMPORT_LIMITS.maxFileBytes) throw new Error('This PDF exceeds the local 256 MiB file limit. Split it into smaller PDFs first.');
  const task = pdfjs.getDocument({
    data, password: options.password, isEvalSupported: false,
    useSystemFonts: true, disableFontFace: false, fontExtraProperties: true,
    useWorkerFetch: false, disableWorkerRendering: true,
    disableAutoFetch: true, disableStream: true, disableRange: true,
    isImageDecoderSupported: false, stopAtErrors: true,
    // PDF.js silently omits images above maxImageSize. Validate decoded image
    // dimensions ourselves so an editable page can never quietly lose an image.
    maxImageSize: -1,
    BinaryDataFactory: OfflineBinaryDataFactory,
    // ICC decoding in PDF.js uses a synchronous URL loader that cannot use the
    // bundled factory. Its built-in alternate color-space conversion is used.
    useWasm: true, verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  let passwordError;
  if (options.onPassword) task.onPassword = (update, reason) => {
    Promise.resolve().then(() => options.onPassword(reason)).then(value => {
      if (typeof value === 'string') update(value);
      else { passwordError = new Error('Password entry cancelled.'); update(passwordError); }
    }).catch(error => { passwordError = error; update(error); });
  };
  const cancel = () => { task.destroy().catch(() => {}); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const pdf = await task.promise;
    abort(options.signal);
    // Keep the importer's document lifecycle stable across PDF.js 6's removal
    // of PDFDocumentProxy.destroy; the loading task owns the worker resources.
    Object.defineProperty(pdf, 'destroy', { value: () => task.destroy() });
    return pdf;
  } catch (error) {
    await task.destroy().catch(() => {});
    abort(options.signal);
    throw passwordError || error;
  } finally {
    options.signal?.removeEventListener('abort', cancel);
  }
}

/** Ranges are one-based, de-duplicated, and sorted in document order. */
export function parsePageRange(value, pageCount) {
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('Invalid PDF page count.');
  if (/^none$/i.test(String(value).trim())) return [];
  if (!String(value ?? '').trim() || /^all$/i.test(String(value).trim())) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const selected = new Set();
  for (const token of String(value).split(',')) {
    const match = token.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
    if (!match) throw new Error('Use page numbers and ranges, for example 1, 3–5.');
    const from = Number(match[1]), to = Number(match[2] || match[1]);
    if (from < 1 || to > pageCount || from > to) throw new Error(`Page ranges must be between 1 and ${pageCount}, in ascending order.`);
    for (let page = from; page <= to; page++) selected.add(page);
  }
  return [...selected].sort((a, b) => a - b);
}

function pageSize(page) {
  const viewport = page.getViewport({ scale: 1 });
  if (![viewport.width, viewport.height].every(v => Number.isFinite(v) && v > 0 && v <= IMPORT_LIMITS.maxPageSide)) throw new Error('This page exceeds the supported 16,384 px page dimensions.');
  return viewport;
}

async function renderCanvas(page, scale, signal) {
  abort(signal);
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.ceil(viewport.width)), height = Math.max(1, Math.ceil(viewport.height));
  if (width > IMPORT_LIMITS.maxImageSide || height > IMPORT_LIMITS.maxImageSide || width * height > IMPORT_LIMITS.maxImagePixels) {
    throw new Error('This density exceeds Figma’s 4,096 px image limit. Choose a lower density or use editable layers.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const task = page.render({ canvasContext: canvas.getContext('2d'), viewport, background: 'rgb(255,255,255)' });
  const cancel = () => task.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try { await task.promise; abort(signal); return canvas; }
  catch (error) { canvas.width = canvas.height = 0; abort(signal); throw error; }
  finally { signal?.removeEventListener('abort', cancel); }
}

export async function renderPreview(pdf, pageNumber, options = {}) {
  const page = await pdf.getPage(pageNumber), viewport = pageSize(page);
  const scale = options.scale || Math.min(1, (options.maxWidth || 180) / Math.max(viewport.width, viewport.height));
  const canvas = await renderCanvas(page, scale, options.signal);
  try { return { dataUrl: canvas.toDataURL('image/png'), width: viewport.width, height: viewport.height }; }
  finally { canvas.width = canvas.height = 0; }
}

function getObject(page, id) {
  return new Promise((resolve, reject) => {
    try { (id.startsWith('g_') ? page.commonObjs : page.objs).get(id, resolve); }
    catch (error) { reject(error); }
  });
}
async function dependencies(page, list, signal) {
  const ids = new Set();
  list.fnArray.forEach((op, i) => { if (op === OPS.dependency) for (const id of list.argsArray[i]) ids.add(id); });
  for (const id of ids) { abort(signal); await getObject(page, id); }
}

function fontDescription(font) {
  const raw = String(font.name || font.systemFontInfo?.baseFontName || font.fallbackName || 'sans-serif').replace(/^[A-Z]{6}\+/, '');
  const postscriptName = raw.replace(/(?:PS)?MT$/i, '');
  // Preserve named weights instead of reducing every font to Regular/Bold.
  // PostScript commonly concatenates the italic suffix (Inter-SemiBoldItalic).
  const suffix = postscriptName.match(/((?:(?:Extra|Ultra|Semi|Demi)[- ]?)?(?:Bold|Light)|Regular|Roman|Book|Normal|Black|Heavy|Medium|Thin)?[- ]?(Italic|Oblique)?$/i);
  const hasSuffix = suffix && suffix[0] && suffix.index > 0 &&
    (/[-_, ]$/.test(postscriptName.slice(0, suffix.index)) || /^[-_, A-Z]/.test(suffix[0]));
  const weightNames = { thin: 'Thin', extralight: 'Extra Light', ultralight: 'Ultra Light', semilight: 'Semi Light', demilight: 'Demi Light', light: 'Light', medium: 'Medium', semibold: 'Semi Bold', demibold: 'Demi Bold', bold: 'Bold', extrabold: 'Extra Bold', ultrabold: 'Ultra Bold', black: 'Black', heavy: 'Heavy', regular: 'Regular', roman: 'Regular', book: 'Book', normal: 'Regular' };
  const weight = hasSuffix && suffix[1] ? weightNames[suffix[1].replace(/[- ]/g, '').toLowerCase()] : font.black ? 'Black' : font.bold ? 'Bold' : 'Regular';
  const italic = Boolean(hasSuffix && suffix[2] || font.italic);
  const style = italic ? `${weight === 'Regular' ? '' : `${weight} `}Italic` : weight;
  const base = hasSuffix ? postscriptName.slice(0, suffix.index).replace(/[-_, ]+$/, '') : postscriptName;
  const family = base.replace(/PS$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2') || raw;
  return { family, style, key: `${family}|${style}`, originalName: raw };
}

export async function collectFonts(pdf, pageNumbers, options = {}) {
  const found = new Map();
  for (const number of pageNumbers || Array.from({ length: pdf.numPages }, (_, i) => i + 1)) {
    abort(options.signal);
    const page = await pdf.getPage(number), list = await page.getOperatorList();
    await dependencies(page, list, options.signal);
    for (let i = 0; i < list.fnArray.length; i++) {
      if (list.fnArray[i] !== OPS.setFont) continue;
      const font = await getObject(page, list.argsArray[i][0]);
      // A Type 3 program is not an installable font. Figma's nonpainting
      // FigmaGlyphs metadata must not appear as a replacement-font choice.
      if (font.isType3Font) continue;
      const description = fontDescription(font);
      found.set(description.key, description);
    }
  }
  return [...found.values()];
}

const multiply = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
function inverse(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) unsupported('a singular drawing transform');
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
const point = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const num = value => { if (!Number.isFinite(value)) throw new Error('Invalid PDF drawing coordinate.'); return Number(value.toFixed(5)); };
const matrix = m => `matrix(${m.map(num).join(' ')})`;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const rectangle = b => `M${num(b[0])} ${num(b[1])}H${num(b[2])}V${num(b[3])}H${num(b[0])}Z`;

export class UnsupportedPdfFeatureError extends Error {
  constructor(feature) { super(`Editable import cannot yet preserve ${feature}. Import this page as an image to preserve its appearance.`); this.name = 'UnsupportedPdfFeatureError'; this.feature = feature; }
}
function unsupported(feature) { throw new UnsupportedPdfFeatureError(feature); }

function drawPath(data) {
  const commands = [], sizes = [2, 2, 6, 4, 0], names = ['M', 'L', 'C', 'Q', 'Z'];
  for (let i = 0; i < data.length;) {
    const op = data[i++], size = sizes[op];
    if (size === undefined || i + size > data.length) throw new Error('Invalid PDF vector path.');
    commands.push(names[op] + Array.from(data.slice(i, i + size), num).join(' ')); i += size;
  }
  return commands.join('');
}

function isAxisAlignedRectangle(path, bounds) {
  if (!bounds || !/^M[-\d.]+ [-\d.]+L[-\d.]+ [-\d.]+L[-\d.]+ [-\d.]+L[-\d.]+ [-\d.]+Z$/.test(path)) return false;
  const coordinates = path.match(/[-\d.]+/g).map(Number);
  const vertices = Array.from({ length: 4 }, (_, index) => coordinates.slice(index * 2, index * 2 + 2));
  const close = (a, b) => Math.abs(a - b) <= 0.00001;
  const corners = new Set();
  for (let i = 0; i < vertices.length; i++) {
    const [x, y] = vertices[i], [nextX, nextY] = vertices[(i + 1) % vertices.length];
    if (!close(x, nextX) && !close(y, nextY)) return false;
    const horizontal = close(x, bounds[0]) ? 0 : close(x, bounds[2]) ? 1 : -1;
    const vertical = close(y, bounds[1]) ? 0 : close(y, bounds[3]) ? 1 : -1;
    if (horizontal < 0 || vertical < 0) return false;
    corners.add(`${horizontal},${vertical}`);
  }
  return corners.size === 4;
}

function rgb(color) {
  if (color === 'transparent') return { r: 0, g: 0, b: 0 };
  const hex = String(color).match(/^#([a-f\d]{6})$/i);
  if (hex) return { r: parseInt(hex[1].slice(0, 2), 16) / 255, g: parseInt(hex[1].slice(2, 4), 16) / 255, b: parseInt(hex[1].slice(4, 6), 16) / 255 };
  const values = String(color).match(/^rgb\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)\s*\)$/);
  if (values) return { r: Number(values[1]) / 255, g: Number(values[2]) / 255, b: Number(values[3]) / 255 };
  unsupported('pattern-filled text');
}

async function imageDataUrl(image, maskColor) {
  const { width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > IMPORT_LIMITS.maxImageSide || height > IMPORT_LIMITS.maxImageSide || width * height > IMPORT_LIMITS.maxImagePixels) unsupported('an embedded image larger than 4,096 px');
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  try {
    const ctx = canvas.getContext('2d');
    if (image.bitmap) ctx.drawImage(image.bitmap, 0, 0);
    else {
      const result = ctx.createImageData(width, height), output = result.data, input = image.data;
      if (!input) throw new Error('The PDF image could not be decoded.');
      const color = maskColor ? rgb(maskColor) : null;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const index = y * width + x, target = index * 4;
        if (maskColor || image.kind === pdfjs.ImageKind.GRAYSCALE_1BPP) {
          const bit = (input[y * Math.ceil(width / 8) + (x >> 3)] >> (7 - (x & 7))) & 1;
          output[target] = color ? Math.round(color.r * 255) : bit * 255;
          output[target + 1] = color ? Math.round(color.g * 255) : bit * 255;
          output[target + 2] = color ? Math.round(color.b * 255) : bit * 255;
          output[target + 3] = color ? (bit ? 0 : 255) : 255;
        } else if (image.kind === pdfjs.ImageKind.RGB_24BPP) {
          output[target] = input[index * 3]; output[target + 1] = input[index * 3 + 1]; output[target + 2] = input[index * 3 + 2]; output[target + 3] = 255;
        } else if (image.kind === pdfjs.ImageKind.RGBA_32BPP || input.length === width * height * 4) {
          output[target] = input[target]; output[target + 1] = input[target + 1]; output[target + 2] = input[target + 2]; output[target + 3] = input[target + 3];
        } else unsupported('this embedded image encoding');
      }
      ctx.putImageData(result, 0, 0);
    }
    if (maskColor && image.bitmap) { ctx.globalCompositeOperation = 'source-in'; ctx.fillStyle = maskColor; ctx.fillRect(0, 0, width, height); }
    return canvas.toDataURL('image/png');
  } finally { canvas.width = canvas.height = 0; }
}

async function convertEditable(page, viewport, options) {
  const list = await page.getOperatorList();
  if (list.fnArray.length > IMPORT_LIMITS.maxOperators) throw new Error('This page has too many drawing operations for editable import. Try image mode.');
  await dependencies(page, list, options.signal);
  const elements = [], texts = [], warnings = new Set(), definitions = [], allGraphics = [];
  let graphics = [], serial = 0, pendingClip = null;
  let state = { transform: viewport.transform.slice(), baseTransform: viewport.transform.slice(), fill: '#000000', stroke: '#000000', fillAlpha: 1, strokeAlpha: 1, lineWidth: 1, lineCap: 0, lineJoin: 0, miter: 10, dash: [], dashOffset: 0, clips: [], font: null, fontSize: 0, textMatrix: IDENTITY.slice(), x: 0, y: 0, lineX: 0, lineY: 0, leading: 0, hScale: 1, charSpacing: 0, wordSpacing: 0, rise: 0, textMode: 0 };
  const stack = [];
  const save = () => stack.push({ ...state, transform: state.transform.slice(), clips: state.clips.slice(), textMatrix: state.textMatrix.slice() });
  const restore = () => { if (!stack.length) throw new Error('Unbalanced PDF graphics state.'); state = stack.pop(); pendingClip = null; };
  const wrap = content => state.clips.reduceRight((text, clip) => `<g clip-path="url(#${clip.id})">${text}</g>`, content);
  const svg = content => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${num(viewport.width)}" height="${num(viewport.height)}" viewBox="0 0 ${num(viewport.width)} ${num(viewport.height)}"><defs>${definitions.join('')}</defs>${content}</svg>`;
  const emit = content => { const wrapped = wrap(content); graphics.push(wrapped); allGraphics.push(wrapped); };
  const flush = () => { if (graphics.length) { elements.push({ type: 'svg', svg: svg(graphics.join('')) }); graphics = []; } };
  function addClip(path, rule = 'nonzero', rect = null, transform = state.transform) {
    const id = `pdffy-clip-${++serial}`;
    definitions.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${path}" transform="${matrix(transform)}" clip-rule="${rule}"/></clipPath>`);
    let bounds = null;
    if (rect && Math.abs(transform[1]) < 1e-6 && Math.abs(transform[2]) < 1e-6) {
      const a = point(transform, rect[0], rect[1]), b = point(transform, rect[2], rect[3]);
      bounds = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    }
    state.clips.push({ id, bounds });
  }
  async function paintPath(path, op, bounds) {
    const fill = [OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].includes(op);
    const stroke = [OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].includes(op);
    const evenodd = [OPS.eoFill, OPS.eoFillStroke, OPS.closeEOFillStroke].includes(op);
    if (fill || stroke) {
      const fillPaint = fill ? await colorPaint(state.fill) : 'none';
      const strokePaint = stroke ? await colorPaint(state.stroke) : 'none';
      emit(`<path d="${path}" transform="${matrix(state.transform)}" fill="${escape(fillPaint)}" fill-opacity="${num(state.fillAlpha)}" fill-rule="${evenodd ? 'evenodd' : 'nonzero'}" stroke="${escape(strokePaint)}" stroke-opacity="${num(state.strokeAlpha)}" stroke-width="${num(state.lineWidth || 0.5)}" stroke-linecap="${['butt', 'round', 'square'][state.lineCap] || 'butt'}" stroke-linejoin="${['miter', 'round', 'bevel'][state.lineJoin] || 'miter'}" stroke-miterlimit="${num(state.miter)}"${state.dash.length ? ` stroke-dasharray="${state.dash.map(num).join(' ')}" stroke-dashoffset="${num(state.dashOffset)}"` : ''}/>`);
    }
    if (pendingClip) {
      // Rectangle clips can be proven to contain text; arbitrary clipping is
      // retained for vectors, but cannot silently be discarded for text.
      const isRect = isAxisAlignedRectangle(path, bounds);
      addClip(path, pendingClip, isRect ? bounds : null); pendingClip = null;
    }
  }
  async function showText(glyphs) {
    if (!state.font || !state.fontSize) return;
    const font = state.font;
    const nonpaintingType3 = font.isType3Font && glyphs.every(glyph => {
      if (typeof glyph === 'number') return true;
      const program = font.charProcOperatorList?.get(glyph.operatorListId);
      return program && program.fnArray.every(op => op === OPS.setCharWidth || op === OPS.setCharWidthAndBounds);
    });
    if (font.isType3Font && !nonpaintingType3) unsupported('painted Type 3 glyph programs');
    if (font.vertical) unsupported('vertical writing');
    if (![0, 3].includes(state.textMode)) unsupported('outlined or clipping text');
    const info = fontDescription(font), fontMatrix = font.fontMatrix || [0.001, 0, 0, 0.001, 0, 0];
    let width = 0, content = '', irregularSpacing = false;
    const direction = state.fontSize < 0 ? -1 : 1, size = Math.abs(state.fontSize);
    for (const glyph of glyphs) {
      if (typeof glyph === 'number') { width -= glyph * size / 1000; if (Math.abs(glyph) > 0.01) irregularSpacing = true; continue; }
      const character = glyph.unicode || '';
      if (nonpaintingType3) {
        width += glyph.width * size * fontMatrix[0] + (state.charSpacing + (glyph.isSpace ? state.wordSpacing : 0)) * direction;
        continue;
      }
      if (typeof character !== 'string' || !character || character.includes('\ufffd')) unsupported('text with a missing Unicode mapping');
      content += character;
      if (glyph.isSpace && state.wordSpacing !== 0) irregularSpacing = true;
      width += glyph.width * size * fontMatrix[0] + (state.charSpacing + (glyph.isSpace ? state.wordSpacing : 0)) * direction;
    }
    const transform = multiply(multiply(state.transform, state.textMatrix), [state.hScale * direction, 0, 0, -direction, state.x, state.y + state.rise]);
    state.x += width * state.hScale * direction;
    if (nonpaintingType3) {
      warnings.add('Outlined text is retained as editable vectors. Its hidden searchable text is not recreated as visible text; font and text editing are unavailable for those outlines.');
      return;
    }
    if (state.textMode === 3 || !content.trim() || state.fillAlpha === 0 || state.fill === 'transparent') return;
    if (irregularSpacing) warnings.add('Some PDF text has custom kerning or word spacing. Overall run widths are retained, but spacing within the editable text may need adjustment.');
    const scaleY = Math.hypot(transform[2], transform[3]), scaleX = Math.hypot(transform[0], transform[1]);
    if (scaleY < 1e-8 || scaleX < 1e-8) return;
    const ascent = Number.isFinite(font.ascent) ? font.ascent : 0.8;
    const descent = Number.isFinite(font.descent) ? Math.min(0, font.descent) : -0.2;
    const [x, y] = point(transform, 0, -ascent * size);
    const height = size * (ascent - descent) * scaleY;
    const corners = [[0, -ascent * size], [width, -ascent * size], [0, -descent * size], [width, -descent * size]].map(p => point(transform, ...p));
    const bounds = [Math.min(...corners.map(p => p[0])), Math.min(...corners.map(p => p[1])), Math.max(...corners.map(p => p[0])), Math.max(...corners.map(p => p[1]))];
    for (const clip of state.clips) {
      if (!clip.bounds || bounds[0] < clip.bounds[0] - 1 || bounds[1] < clip.bounds[1] - 1 || bounds[2] > clip.bounds[2] + 1 || bounds[3] > clip.bounds[3] + 1) unsupported('partially clipped text');
    }
    const mapped = options.fontMap?.[info.key] || options.fontMap?.[info.family];
    const descriptor = { type: 'text', text: content, fontFamily: typeof mapped === 'string' ? mapped : mapped?.family || info.family, fontStyle: mapped?.style || info.style, originalFont: info.originalName, fontKey: info.key, fontSize: size * scaleY, x, y, width: Math.abs(width * scaleX), height, color: rgb(state.fill), opacity: state.fillAlpha, rotation: Math.atan2(transform[1], transform[0]) * 180 / Math.PI, transform: [[transform[0] / scaleY, transform[2] / scaleY, x], [transform[1] / scaleY, transform[3] / scaleY, y]], fitWidth: true };
    flush(); elements.push(descriptor); texts.push(descriptor);
  }
  async function image(image, transform = state.transform, mask = false) {
    const href = await imageDataUrl(image, mask ? state.fill : undefined);
    const m = multiply(transform, [1, 0, 0, -1, 0, 1]);
    emit(`<image x="0" y="0" width="1" height="1" preserveAspectRatio="none" transform="${matrix(m)}" opacity="${num(state.fillAlpha)}" xlink:href="${href}"/>`);
  }
  async function gradientDefinition(id, transform) {
    const ir = await getObject(page, id);
    if (ir[0] !== 'RadialAxial') unsupported('mesh gradients');
    const [, type, bbox, stops, p0, p1, r0, r1] = ir;
    const name = `pdffy-gradient-${++serial}`;
    const colors = stops.map(([offset, color]) => `<stop offset="${num(offset)}" stop-color="${escape(color)}"/>`).join('');
    if (type === 'axial') definitions.push(`<linearGradient id="${name}" gradientUnits="userSpaceOnUse" x1="${num(p0[0])}" y1="${num(p0[1])}" x2="${num(p1[0])}" y2="${num(p1[1])}" gradientTransform="${matrix(transform)}">${colors}</linearGradient>`);
    else if (type === 'radial' && r0 === 0 && r1 > 0) definitions.push(`<radialGradient id="${name}" gradientUnits="userSpaceOnUse" cx="${num(p1[0])}" cy="${num(p1[1])}" r="${num(r1)}" fx="${num(p0[0])}" fy="${num(p0[1])}" gradientTransform="${matrix(transform)}">${colors}</radialGradient>`);
    else unsupported('two-circle radial gradients');
    return { name, bbox };
  }
  async function colorPaint(color) {
    if (typeof color === 'string') return color;
    const transform = multiply(inverse(state.transform), multiply(color.baseTransform, color.matrix || IDENTITY));
    const { name, bbox } = await gradientDefinition(color.id, transform);
    if (bbox) unsupported('bounded gradient patterns');
    return `url(#${name})`;
  }
  async function gradient(id, transform = state.transform) {
    const { name, bbox } = await gradientDefinition(id, transform);
    if (bbox) { save(); addClip(rectangle(bbox), 'nonzero', bbox, transform); }
    emit(`<rect x="0" y="0" width="${num(viewport.width)}" height="${num(viewport.height)}" fill="url(#${name})" opacity="${num(state.fillAlpha)}"/>`);
    if (bbox) restore();
  }

  for (let i = 0; i < list.fnArray.length; i++) {
    if (i % 100 === 0) { abort(options.signal); await tick(); }
    if (elements.length > IMPORT_LIMITS.maxElements) throw new Error('This page has more than 10,000 editable layers. Try image mode.');
    const op = list.fnArray[i], args = list.argsArray[i] || [];
    switch (op) {
      case OPS.dependency: case OPS.setRenderingIntent: case OPS.setFlatness: case OPS.markPoint: case OPS.markPointProps: case OPS.beginMarkedContent: case OPS.endMarkedContent: case OPS.beginCompat: case OPS.endCompat: case OPS.endText: break;
      case OPS.beginMarkedContentProps: if (args[0] === 'OC') unsupported('optional-content layers'); break;
      case OPS.save: save(); break;
      case OPS.restore: restore(); break;
      case OPS.transform: state.transform = multiply(state.transform, args); break;
      case OPS.setLineWidth: state.lineWidth = args[0]; break;
      case OPS.setLineCap: state.lineCap = args[0]; break;
      case OPS.setLineJoin: state.lineJoin = args[0]; break;
      case OPS.setMiterLimit: state.miter = args[0]; break;
      case OPS.setDash: [state.dash, state.dashOffset] = args; break;
      case OPS.setFillRGBColor: state.fill = args[0]; break;
      case OPS.setStrokeRGBColor: state.stroke = args[0]; break;
      case OPS.setFillTransparent: state.fill = 'transparent'; break;
      case OPS.setStrokeTransparent: state.stroke = 'transparent'; break;
      case OPS.setGState:
        for (const [key, value] of args[0]) {
          if (key === 'ca') state.fillAlpha = value;
          else if (key === 'CA') state.strokeAlpha = value;
          else if (key === 'LW') state.lineWidth = value;
          else if (key === 'LC') state.lineCap = value;
          else if (key === 'LJ') state.lineJoin = value;
          else if (key === 'ML') state.miter = value;
          else if (key === 'D') [state.dash, state.dashOffset] = value;
          else if (key === 'Font') { state.font = await getObject(page, value[0]); state.fontSize = value[1]; }
          else if (key === 'BM' && value !== 'source-over') unsupported('non-normal blend modes');
          else if (key === 'SMask' && value) unsupported('soft transparency masks');
          else if (key === 'TR' && value) unsupported('transfer functions');
        }
        break;
      case OPS.constructPath: {
        const [operation, data, bounds] = args;
        await paintPath(bounds ? drawPath(data[0]) : '', operation, bounds); break;
      }
      case OPS.clip: pendingClip = 'nonzero'; break;
      case OPS.eoClip: pendingClip = 'evenodd'; break;
      case OPS.beginText: state.textMatrix = IDENTITY.slice(); state.x = state.y = state.lineX = state.lineY = 0; break;
      case OPS.setFont: state.font = await getObject(page, args[0]); state.fontSize = args[1]; break;
      case OPS.setTextMatrix: state.textMatrix = args.length === 1 ? Array.from(args[0]) : args.slice(); state.x = state.y = state.lineX = state.lineY = 0; break;
      case OPS.setCharSpacing: state.charSpacing = args[0]; break;
      case OPS.setWordSpacing: state.wordSpacing = args[0]; break;
      case OPS.setHScale: state.hScale = args[0] / 100; break;
      case OPS.setLeading: state.leading = -args[0]; break;
      case OPS.setTextRise: state.rise = args[0]; break;
      case OPS.setTextRenderingMode: state.textMode = args[0]; break;
      case OPS.moveText: state.x = state.lineX += args[0]; state.y = state.lineY += args[1]; break;
      case OPS.setLeadingMoveText: state.leading = args[1]; state.x = state.lineX += args[0]; state.y = state.lineY += args[1]; break;
      case OPS.nextLine: state.x = state.lineX; state.y = state.lineY += state.leading; break;
      case OPS.showText: case OPS.showSpacedText: await showText(args[0]); break;
      case OPS.nextLineShowText: state.x = state.lineX; state.y = state.lineY += state.leading; await showText(args[0]); break;
      case OPS.nextLineSetSpacingShowText: state.wordSpacing = args[0]; state.charSpacing = args[1]; state.x = state.lineX; state.y = state.lineY += state.leading; await showText(args[2]); break;
      case OPS.paintFormXObjectBegin: save(); if (args[0]) state.transform = multiply(state.transform, args[0]); state.baseTransform = state.transform.slice(); if (args[1]) addClip(rectangle(args[1]), 'nonzero', args[1]); break;
      case OPS.paintFormXObjectEnd: restore(); break;
      case OPS.beginGroup: {
        const group = args[0];
        if (group.smask || group.hasSoftMask || group.knockout || group.needsIsolation || state.fillAlpha !== 1) unsupported('isolated transparency groups');
        save(); if (group.bbox) addClip(rectangle(group.bbox), 'nonzero', group.bbox, group.matrix ? multiply(state.transform, group.matrix) : state.transform); break;
      }
      case OPS.endGroup: restore(); break;
      case OPS.paintImageXObject: await image(await getObject(page, args[0])); break;
      case OPS.paintInlineImageXObject: await image(args[0]); break;
      case OPS.paintImageMaskXObject: { const value = args[0]; await image(typeof value.data === 'string' ? await getObject(page, value.data) : value, state.transform, true); break; }
      case OPS.paintImageXObjectRepeat: {
        const data = await getObject(page, args[0]);
        for (let j = 0; j < args[3].length; j += 2) await image(data, multiply(state.transform, [args[1], 0, 0, args[2], args[3][j], args[3][j + 1]])); break;
      }
      case OPS.paintSolidColorImageMask: emit(`<path d="M0 0H1V1H0Z" transform="${matrix(state.transform)}" fill="${escape(state.fill)}" opacity="${num(state.fillAlpha)}"/>`); break;
      case OPS.shadingFill: await gradient(args[0]); break;
      case OPS.setFillColorN: case OPS.setStrokeColorN:
        if (args[0] === 'TilingPattern') unsupported('tiled pattern fills');
        state[op === OPS.setFillColorN ? 'fill' : 'stroke'] = { id: args[1], matrix: args[2], baseTransform: state.baseTransform.slice() }; break;
      case OPS.beginAnnotation: case OPS.endAnnotation: unsupported('annotation appearances'); break;
      default: unsupported(`PDF drawing operation ${Object.keys(OPS).find(name => OPS[name] === op) || op}`);
    }
  }
  flush(); abort(options.signal);
  // Annotations are outside the ordinary page painting stream. Never imply
  // interactive forms or comments have become fully editable Figma controls.
  const annotations = await page.getAnnotations({ intent: 'display' });
  if (annotations.some(annotation => annotation.subtype !== 'Link')) warnings.add('PDF form fields, comments and annotation appearances are not recreated as editable controls.');
  return { width: viewport.width, height: viewport.height, elements, texts, svg: svg(allGraphics.join('')), warnings: [...warnings] };
}

export async function convertPage(pdf, pageNumber, options = {}) {
  abort(options.signal);
  const page = await pdf.getPage(pageNumber), viewport = pageSize(page);
  if (options.mode === 'image') {
    const scale = Number(options.scale ?? 1);
    if (!Number.isFinite(scale) || scale <= 0 || scale > 4) throw new Error('Image density must be between 0 and 4×.');
    const canvas = await renderCanvas(page, scale, options.signal);
    try {
      const imageBytes = bytesFromBase64(canvas.toDataURL('image/png').split(',')[1]);
      const { links, warnings } = await extractLinks(pdf, page, viewport);
      return { width: viewport.width, height: viewport.height, imageBytes, links, warnings };
    } finally { canvas.width = canvas.height = 0; }
  }
  if (options.mode && options.mode !== 'editable') throw new Error('Unknown PDF import mode.');
  const result = await convertEditable(page, viewport, options);
  const { links, warnings } = await extractLinks(pdf, page, viewport);
  return { ...result, links, warnings: [...new Set([...result.warnings, ...warnings])] };
}

async function extractLinks(pdf, page, viewport) {
  const links = [], warnings = new Set();
  const annotations = await page.getAnnotations({ intent: 'display' });
  for (const annotation of annotations) {
    if (annotation.subtype !== 'Link' || !Array.isArray(annotation.rect) || annotation.rect.length !== 4) continue;
    const [x0, y0] = point(viewport.transform, annotation.rect[0], annotation.rect[1]);
    const [x1, y1] = point(viewport.transform, annotation.rect[2], annotation.rect[3]);
    const x = Math.max(0, Math.min(x0, x1)), y = Math.max(0, Math.min(y0, y1));
    const width = Math.min(viewport.width, Math.max(x0, x1)) - x, height = Math.min(viewport.height, Math.max(y0, y1)) - y;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
    const rawUrl = annotation.url;
    let url;
    if (typeof rawUrl === 'string' && !/[\u0000-\u001f\u007f]/.test(rawUrl)) {
      try { const parsed = new URL(rawUrl); if (['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)) url = parsed.href; } catch (_) { /* rejected below */ }
    }
    if (url) { links.push({ x, y, width, height, url }); continue; }
    if (annotation.dest) {
      try {
        const destination = typeof annotation.dest === 'string' ? await pdf.getDestination(annotation.dest) : annotation.dest;
        if (Array.isArray(destination) && destination.length) {
          const ref = destination[0], index = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref);
          if (Number.isInteger(index) && index >= 0 && index < pdf.numPages) { links.push({ x, y, width, height, destinationPageNumber: index + 1 }); continue; }
        }
      } catch (_) { /* destination may not exist in a damaged PDF */ }
    }
    warnings.add('An unsupported PDF hyperlink action was omitted.');
  }
  return { links, warnings: [...warnings] };
}
