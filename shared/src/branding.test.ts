import { describe, expect, it } from 'vitest';
import { checkLogo, readImageInfo, svgDanger, svgSize } from './branding';

const enc = (s: string) => new TextEncoder().encode(s);

function png(w: number, h: number) {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

/** SOI, an APP0 segment, then a frame header (baseline C0 or progressive C2). */
function jpeg(w: number, h: number, sof = 0xc0) {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const frame = [0xff, sof, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, 0xff, 0xff, ...frame, 0xff, 0xd9]);
}

describe('readImageInfo', () => {
  it('reads PNG dimensions from IHDR', () => {
    expect(readImageInfo(png(320, 120))).toEqual({ type: 'png', width: 320, height: 120 });
  });
  it('reads baseline and progressive JPEG frames (skipping APP segments and fill bytes)', () => {
    expect(readImageInfo(jpeg(400, 100))).toEqual({ type: 'jpeg', width: 400, height: 100 });
    expect(readImageInfo(jpeg(250, 250, 0xc2))).toEqual({ type: 'jpeg', width: 250, height: 250 });
  });
  it('detects SVG by content, with prolog and comments', () => {
    const svg = enc('﻿<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><rect/></svg>');
    expect(readImageInfo(svg)).toEqual({ type: 'svg', width: 400, height: 100 });
  });
  it('rejects things that only claim to be images', () => {
    expect(readImageInfo(enc('hello, I am a .png'))).toBeNull();
    expect(readImageInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    expect(readImageInfo(enc('<html><svg></svg></html>'))).toBeNull();
  });
});

describe('svgSize', () => {
  it('prefers viewBox, falls back to width/height', () => {
    expect(svgSize('<svg viewBox="0,0,300,150" width="10" height="90">')).toEqual({ width: 300, height: 150 });
    expect(svgSize('<svg width="240px" height="120">')).toEqual({ width: 240, height: 120 });
    expect(svgSize('<svg width="100%" height="100%">')).toBeNull();
  });
});

describe('svgDanger', () => {
  it.each([
    ['<svg><script>alert(1)</script></svg>', 'scripts'],
    ['<svg onload="x()"></svg>', 'event handlers'],
    ['<svg><foreignObject><p/></foreignObject></svg>', 'embedded HTML'],
    ['<svg><a href="javascript:alert(1)"/></svg>', 'script links'],
    ['<svg><image href="https://evil.example/x.png"/></svg>', 'links to other files'],
    ['<!DOCTYPE svg [<!ENTITY x "y">]><svg/>', 'XML entities'],
  ])('rejects %s', (svg, what) => {
    expect(svgDanger(svg)).toContain(what);
  });
  it('allows plain shapes, internal references and embedded raster data', () => {
    expect(svgDanger('<svg viewBox="0 0 4 1"><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/><image href="data:image/png;base64,AAAA"/></svg>')).toBeNull();
  });
});

describe('checkLogo', () => {
  const ok = (w: number, h: number, type: 'png' | 'svg' = 'png') => checkLogo({ type, width: w, height: h, bytes: 10_000 });
  it('accepts square to 4:1 within 100–500 px', () => {
    expect(ok(100, 100)).toBeNull();
    expect(ok(500, 500)).toBeNull();
    expect(ok(400, 100)).toBeNull();
    expect(ok(495, 500)).toBeNull(); // within 1 % of square
  });
  it('rejects portrait, too wide, too small and too large', () => {
    expect(ok(300, 600)).toMatch(/portrait/);
    expect(ok(480, 500)).toMatch(/portrait/);
    expect(ok(500, 120)).toMatch(/4:1/);
    expect(ok(99, 99)).toMatch(/too small/);
    expect(ok(501, 200)).toMatch(/too large/);
  });
  it('applies only the ratio to SVG', () => {
    expect(ok(4000, 1000, 'svg')).toBeNull();
    expect(ok(10, 10, 'svg')).toBeNull();
    expect(ok(10, 20, 'svg')).toMatch(/portrait/);
  });
  it('enforces the 512 KB limit', () => {
    expect(checkLogo({ type: 'png', width: 200, height: 200, bytes: 600 * 1024 })).toMatch(/512 KB/);
  });
});
