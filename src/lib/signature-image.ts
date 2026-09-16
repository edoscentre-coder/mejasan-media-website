/**
 * Make an uploaded signature look like a signed one.
 *
 * A signature drawn on the client form is #1a1a1a on a transparent canvas, so
 * it sits on the contract as clean ink. A company signature is a photograph of
 * a signature on paper: blue biro, a grey-white sheet, a shadow down one side,
 * JPEG noise. Dropped into the same PDF cell the two look like they came from
 * different documents — and they did.
 *
 * This lifts the ink off the paper. It reads the background from the border of
 * the image, makes anything close to that background transparent, repaints what
 * is left in the same ink as the drawn signatures, and crops to the writing.
 * What comes back is a PNG that matches the client's signature in colour,
 * background and framing.
 *
 * Browser only — it runs on a canvas at upload time, so the cleaned image is
 * what gets stored and every document from then on is already right.
 */

/** The colour the client form draws with, so both sides of the contract match. */
export const SIGNATURE_INK = { r: 0x1a, g: 0x1a, b: 0x1a };

/**
 * Ink is found in two passes, not one.
 *
 * A single threshold cannot separate a pen stroke from a shadow: set it low and
 * the darker half of the sheet survives as a grey wash the shape of the
 * photograph, set it high and faint strokes break up. So anything clearly
 * darker than the paper is ink (STRONG), anything marginally darker is ink only
 * if it touches ink (WEAK). A shadow is marginal everywhere and touches
 * nothing, so it goes; the soft edge of a stroke is marginal but connected, so
 * it stays.
 */
const WEAK_FLOOR = 16;
const STRONG_FLOOR = 46;

/** Ink is a fraction of a signature's own depth range, not a fixed number. */
const STRONG_FRACTION = 0.34;

/** Below this the pixel contributes nothing visible and only dirties the edge. */
const MIN_ALPHA = 24;

/** Ink rarely fills a photo; this keeps a stray dark edge from defeating the crop. */
const TRIM_PADDING = 6;

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * The paper's brightness, read from the border.
 *
 * A signature does not usually touch the edge of its own photograph, so the
 * outer ring is background. The median resists a dark corner or a shadow in a
 * way a mean does not.
 */
function estimateBackground(data: Uint8ClampedArray, w: number, h: number): number {
  const ring: number[] = [];
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.04));

  for (let y = 0; y < h; y++) {
    const edgeRow = y < band || y >= h - band;
    for (let x = 0; x < w; x++) {
      if (!edgeRow && x >= band && x < w - band) continue;
      const i = (y * w + x) * 4;
      if (data[i + 3] < 8) continue; // already transparent — not paper
      ring.push(luminance(data[i], data[i + 1], data[i + 2]));
    }
  }

  if (ring.length === 0) return 255;
  ring.sort((a, b) => a - b);
  return ring[Math.floor(ring.length / 2)];
}

export interface CleanSignatureOptions {
  /** Longest edge of the result. Generous, so the PDF has pixels to downscale. */
  maxSize?: number;
}

/**
 * Returns a cleaned PNG blob, or null if the file could not be read as an image.
 * A file that is already a transparent PNG is recoloured and cropped but never
 * background-knocked — there is no paper to remove.
 */
export async function cleanSignatureImage(
  file: File | Blob,
  { maxSize = 1200 }: CleanSignatureOptions = {},
): Promise<Blob | null> {
  const url = URL.createObjectURL(file);

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new window.Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("not an image"));
      el.src = url;
    });

    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return null;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;

    ctx.drawImage(img, 0, 0);
    const image = ctx.getImageData(0, 0, w, h);
    const data = image.data;

    // A drawn signature arrives with most of its pixels already transparent.
    let transparent = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 8) transparent++;
    const alreadyCut = transparent > (w * h) / 4;

    const bg = alreadyCut ? 255 : estimateBackground(data, w, h);

    // How dark the darkest real ink is, so faint signatures still reach full
    // opacity instead of coming out grey.
    let darkest = bg;
    if (!alreadyCut) {
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 8) continue;
        const l = luminance(data[i], data[i + 1], data[i + 2]);
        if (l < darkest) darkest = l;
      }
    }
    // For an alpha-carried signature the scale is the alpha channel's own.
    const range = alreadyCut ? 255 : Math.max(1, bg - darkest);

    // Pass one: how strongly each pixel reads as ink.
    //
    // On a photograph that is how far below the paper it sits. On an image that
    // already has an alpha channel — a drawn signature, or one of these that has
    // been through here before — the ink is the alpha itself; reading luminance
    // there would see the flat ink colour everywhere and call a faint wash
    // solid, so a second pass would never clean up what a first pass left.
    const depth = new Float32Array(w * h);
    for (let p = 0; p < w * h; p++) {
      const i = p * 4;
      if (data[i + 3] < 8) {
        depth[p] = 0;
      } else if (alreadyCut) {
        depth[p] = data[i + 3];
      } else {
        depth[p] = bg - luminance(data[i], data[i + 1], data[i + 2]);
      }
    }

    // Definite ink: clearly darker than the paper, judged against this
    // signature's own range so a faint pen is not held to a bold pen's standard.
    const strongAt = Math.max(STRONG_FLOOR, range * STRONG_FRACTION);

    // Pass two: grow outward from definite ink through the marginal pixels.
    // A shadow is marginal everywhere and never touches ink, so it is left
    // behind; the soft halo of a stroke is marginal but attached, so it comes.
    const keep = new Uint8Array(w * h);
    const stack: number[] = [];

    for (let p = 0; p < w * h; p++) {
      if (depth[p] >= strongAt) {
        keep[p] = 1;
        stack.push(p);
      }
    }

    while (stack.length > 0) {
      const p = stack.pop() as number;
      const x = p % w;
      const y = (p / w) | 0;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (keep[q] || depth[q] < WEAK_FLOOR) continue;
          keep[q] = 1;
          stack.push(q);
        }
      }
    }

    let minX = w, minY = h, maxX = -1, maxY = -1;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const i = p * 4;

        if (!keep[p]) {
          data[i + 3] = 0;
          continue;
        }

        // Alpha still follows depth, so a stroke keeps its soft edge rather
        // than becoming a stencil — but anything too faint to read is dropped
        // instead of laying down a grey film.
        const alpha = Math.min(255, Math.round(((depth[p] - WEAK_FLOOR) / range) * 255 * 1.9));
        if (alpha < MIN_ALPHA) {
          data[i + 3] = 0;
          continue;
        }

        data[i] = SIGNATURE_INK.r;
        data[i + 1] = SIGNATURE_INK.g;
        data[i + 2] = SIGNATURE_INK.b;
        data[i + 3] = alpha;

        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    // Nothing survived — the image was blank, or all one tone. Leave it alone
    // rather than returning an empty rectangle.
    if (maxX < 0 || maxY < 0) return null;

    ctx.putImageData(image, 0, 0);

    const left = Math.max(0, minX - TRIM_PADDING);
    const top = Math.max(0, minY - TRIM_PADDING);
    const cropW = Math.min(w, maxX + TRIM_PADDING) - left + 1;
    const cropH = Math.min(h, maxY + TRIM_PADDING) - top + 1;

    const scale = Math.min(1, maxSize / Math.max(cropW, cropH));
    const outW = Math.max(1, Math.round(cropW * scale));
    const outH = Math.max(1, Math.round(cropH * scale));

    const out = document.createElement("canvas");
    out.width = outW;
    out.height = outH;
    const octx = out.getContext("2d");
    if (!octx) return null;

    octx.imageSmoothingQuality = "high";
    octx.drawImage(canvas, left, top, cropW, cropH, 0, 0, outW, outH);

    return await new Promise<Blob | null>((resolve) =>
      out.toBlob((b) => resolve(b), "image/png"),
    );
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
