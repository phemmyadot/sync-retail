import { checkLogo, LOGO_RULES, readImageInfo, svgDanger, svgSize, type LogoType } from '@sync-retail/shared';

export interface LogoCheck {
  ok: boolean;
  error?: string;
  type?: LogoType;
  width?: number;
  height?: number;
  /** Object URL for the preview; revoke when done. */
  previewUrl?: string;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('unreadable'));
    img.src = url;
  });
}

/**
 * Checks a logo in the browser before it is uploaded: type from the file's
 * own bytes, size, real decoded dimensions and aspect ratio. Uses the same
 * rules as the server (shared/src/branding.ts), which checks again.
 */
export async function validateLogo(file: File): Promise<LogoCheck> {
  if (file.size > LOGO_RULES.maxBytes) {
    return { ok: false, error: `Logo files must be ${LOGO_RULES.maxBytes / 1024} KB or smaller — this one is ${Math.ceil(file.size / 1024)} KB.` };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = readImageInfo(bytes);
  if (!info) return { ok: false, error: 'That file isn’t a PNG, JPEG or SVG image.' };

  let { width, height } = info;
  if (info.type === 'svg') {
    const text = new TextDecoder().decode(bytes);
    const danger = svgDanger(text);
    if (danger) return { ok: false, error: danger };
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (doc.querySelector('parsererror') || doc.documentElement.nodeName.toLowerCase() !== 'svg') {
      return { ok: false, error: 'That SVG file is damaged and can’t be read.' };
    }
    const size = svgSize(text);
    if (!size) return { ok: false, error: 'The SVG needs a viewBox (or width and height) so its shape is known.' };
    ({ width, height } = size);
  }

  // Decode it for real: catches corrupt files and confirms the header's size.
  const typed = new Blob([bytes], { type: { png: 'image/png', jpeg: 'image/jpeg', svg: 'image/svg+xml' }[info.type] });
  const previewUrl = URL.createObjectURL(typed);
  try {
    const img = await loadImage(previewUrl);
    if (info.type !== 'svg') {
      width = img.naturalWidth;
      height = img.naturalHeight;
    }
  } catch {
    URL.revokeObjectURL(previewUrl);
    return { ok: false, error: 'That image can’t be displayed — it may be damaged.' };
  }

  const problem = checkLogo({ type: info.type, width, height, bytes: file.size });
  if (problem) {
    URL.revokeObjectURL(previewUrl);
    return { ok: false, error: problem, type: info.type, width, height };
  }
  return { ok: true, type: info.type, width, height, previewUrl };
}
