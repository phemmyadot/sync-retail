/**
 * Store logo rules and image readers, shared by the browser (before upload)
 * and the server (authoritative). See docs/done/BRANDING_PLAN.md.
 */

export const LOGO_RULES = {
  maxBytes: 512 * 1024,
  minPx: 100,
  maxPx: 500,
  /** width ÷ height. 1 = square, 4 = wide banner. Portrait is never allowed. */
  minRatio: 1,
  maxRatio: 4,
  /** 495×500 still counts as square. */
  ratioTolerance: 0.01,
} as const;

export type LogoType = 'png' | 'jpeg' | 'svg';
export const LOGO_MIME: Record<LogoType, string> = { png: 'image/png', jpeg: 'image/jpeg', svg: 'image/svg+xml' };

export interface ImageInfo {
  type: LogoType;
  width: number;
  height: number;
}

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];

function pngSize(b: Uint8Array): ImageInfo | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !sig.every((v, i) => b[i] === v)) return null;
  // First chunk must be IHDR: width and height are big-endian at 16 and 20.
  if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== 'IHDR') return null;
  return { type: 'png', width: be32(b, 16), height: be32(b, 20) };
}

// Start-of-frame markers (baseline, progressive, lossless, arithmetic…), not DHT/JPG/DAC.
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(b: Uint8Array): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1];
    while (marker === 0xff && i + 2 < b.length) marker = b[++i + 1]; // fill bytes
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end / scan data before any frame header
    const len = be16(b, i + 2);
    if (SOF.has(marker)) return { type: 'jpeg', height: be16(b, i + 5), width: be16(b, i + 7) };
    i += 2 + len;
  }
  return null;
}

const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: false }) : null;
const asText = (b: Uint8Array) => (decoder ? decoder.decode(b) : String.fromCharCode(...b));

/** True if the bytes look like an SVG document (XML prolog/comments allowed before <svg>). */
export function looksLikeSvg(b: Uint8Array): boolean {
  const head = asText(b.subarray(0, 2048)).replace(/^﻿/, '').trimStart();
  return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head);
}

/** Aspect source for an SVG: viewBox, else numeric width/height on the root element. */
export function svgSize(text: string): { width: number; height: number } | null {
  const root = /<svg\b([^>]*)>/i.exec(text)?.[1];
  if (!root) return null;
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root)?.[1];
  const vb = attr('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { width: vb[2], height: vb[3] };
  const num = (v?: string) => (v && /^\s*[\d.]+\s*(px)?\s*$/i.test(v) ? parseFloat(v) : NaN);
  const w = num(attr('width'));
  const h = num(attr('height'));
  return w > 0 && h > 0 ? { width: w, height: h } : null;
}

const SVG_DANGERS: [RegExp, string][] = [
  [/<script[\s>/]/i, 'scripts'],
  [/\son[a-z]+\s*=/i, 'event handlers'],
  [/<foreignObject[\s>/]/i, 'embedded HTML'],
  [/<(iframe|embed|object)[\s>/]/i, 'embedded content'],
  [/<!ENTITY/i, 'XML entities'],
  [/javascript:/i, 'script links'],
  [/(xlink:)?href\s*=\s*["']\s*(?!#|data:image\/)[^"']+/i, 'links to other files'],
  [/@import/i, 'external styles'],
];

/** Why an SVG isn't safe to serve as a logo, or null. */
export function svgDanger(text: string): string | null {
  for (const [re, what] of SVG_DANGERS) if (re.test(text)) return `SVG logos can’t contain ${what}. Export it again as a plain SVG, or use PNG.`;
  return null;
}

/** Reads the type and size from a file's own bytes (never trusts the name or MIME). */
export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
  const png = pngSize(bytes);
  if (png) return png;
  const jpeg = jpegSize(bytes);
  if (jpeg) return jpeg;
  if (looksLikeSvg(bytes)) {
    const s = svgSize(asText(bytes));
    return s ? { type: 'svg', width: s.width, height: s.height } : null;
  }
  return null;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Checks the rules for a logo; returns a message for staff, or null when it's fine. */
export function checkLogo(info: { type: LogoType; width: number; height: number; bytes: number }): string | null {
  const R = LOGO_RULES;
  if (info.bytes > R.maxBytes) return `Logo files must be ${R.maxBytes / 1024} KB or smaller — this one is ${Math.ceil(info.bytes / 1024)} KB.`;
  const ratio = info.width / info.height;
  const size = `${fmt(info.width)}×${fmt(info.height)}`;
  const shape = `Logo must be horizontal or square and between ${R.minPx}×${R.minPx} and ${R.maxPx}×${R.maxPx} pixels`;
  if (ratio < R.minRatio - R.ratioTolerance) return `${shape} — this one is ${size} (portrait).`;
  if (ratio > R.maxRatio + 1e-9) return `${shape}, no wider than 4:1 — this one is ${size} (${ratio.toFixed(1)}:1).`;
  if (info.type !== 'svg') {
    if (info.width < R.minPx || info.height < R.minPx) return `${shape} — this one is ${size} (too small to look sharp).`;
    if (info.width > R.maxPx || info.height > R.maxPx) return `${shape} — this one is ${size} (too large).`;
  }
  return null;
}
