/**
 * FullShot — minimal PDF writer.
 *
 * A screenshot PDF is one image per page and nothing else, so a general PDF
 * library (jsPDF and friends are ~300 KB) would be dead weight in an extension
 * that ships no dependencies and no remote code. This writes the ~40 lines of
 * PDF syntax that case actually needs.
 *
 * Pages embed JPEG bytes verbatim through /DCTDecode: canvas already produces
 * JPEG, so there is no re-encoding and no raw bitmap held in memory. That does
 * mean PDF export is lossy — PNG remains the lossless path, and the quality
 * selector applies here too.
 */

/** A4 in PostScript points (1 pt = 1/72"). */
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

/** Acrobat refuses pages larger than 200 inches on a side. */
const MAX_PAGE_PT = 14400;

const utf8 = new TextEncoder();
const bytes = (text) => utf8.encode(text);

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** PDF date syntax: D:YYYYMMDDHHmmSS. */
function pdfDate(date) {
  const p2 = (n) => String(n).padStart(2, '0');
  return (
    `D:${date.getFullYear()}${p2(date.getMonth() + 1)}${p2(date.getDate())}` +
    `${p2(date.getHours())}${p2(date.getMinutes())}${p2(date.getSeconds())}`
  );
}

/** Escape the few characters that are special inside a PDF literal string. */
const pdfString = (value) => String(value).replace(/([\\()])/g, '\\$1').slice(0, 400);

/**
 * Cut `source` into horizontal slices and JPEG-encode each one.
 * A single reusable canvas keeps peak memory to one slice.
 */
async function encodeSlices(source, sliceHeight, quality) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const slices = [];

  for (let top = 0; top < source.height; top += sliceHeight) {
    const height = Math.min(sliceHeight, source.height - top);
    canvas.width = source.width;
    canvas.height = height;
    // JPEG has no alpha; without this, transparent pixels come out black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, source.width, height);
    ctx.drawImage(source, 0, top, source.width, height, 0, 0, source.width, height);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('The page could not be encoded.'))),
        'image/jpeg',
        quality / 100
      );
    });
    slices.push({ data: new Uint8Array(await blob.arrayBuffer()), width: source.width, height });
  }

  canvas.width = 1;
  canvas.height = 1;
  return slices;
}

/**
 * Build a PDF from an image source (canvas or ImageBitmap).
 *
 * @param options.mode    'single' — one page as tall as the screenshot
 *                        'a4'     — as many A4 pages as it takes
 * @param options.quality JPEG quality, 1–100
 * @param options.title   shown in the document properties
 */
export async function buildPdf(source, { mode = 'single', quality = 92, title = '' } = {}) {
  let slices;
  let pageSize;

  if (mode === 'a4') {
    // Fit the screenshot's width to the A4 width; slice every A4 height.
    const scale = A4_WIDTH / source.width;
    const sliceHeight = Math.max(1, Math.round(A4_HEIGHT / scale));
    slices = await encodeSlices(source, sliceHeight, quality);
    pageSize = (slice) => [A4_WIDTH, slice.height * scale];
  } else {
    // One page, A4 wide, as tall as it needs to be — within Acrobat's limit.
    let scale = A4_WIDTH / source.width;
    if (source.height * scale > MAX_PAGE_PT) scale = MAX_PAGE_PT / source.height;
    slices = await encodeSlices(source, source.height, quality);
    pageSize = (slice) => [slice.width * scale, slice.height * scale];
  }

  /* ---- assemble the file ------------------------------------------------ */

  const chunks = [];
  const offsets = [];
  let length = 0;

  const push = (chunk) => {
    chunks.push(chunk);
    length += chunk.length;
  };
  const startObject = (id) => {
    offsets[id] = length;
    push(bytes(`${id} 0 obj\n`));
  };
  const endObject = () => push(bytes('endobj\n'));

  // A binary comment on line 2 marks the file as binary for transfer tools.
  push(bytes('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));

  // Objects 1 (catalog), 2 (page tree), 3 (info), then 3 per page.
  const pageId = (index) => 4 + index * 3;
  const pageIds = slices.map((_, index) => pageId(index));

  startObject(1);
  push(bytes('<< /Type /Catalog /Pages 2 0 R >>\n'));
  endObject();

  startObject(2);
  push(
    bytes(
      `<< /Type /Pages /Count ${slices.length} /Kids [${pageIds
        .map((id) => `${id} 0 R`)
        .join(' ')}] >>\n`
    )
  );
  endObject();

  startObject(3);
  push(
    bytes(
      `<< /Producer (FullShot) /Creator (FullShot)` +
        `${title ? ` /Title (${pdfString(title)})` : ''}` +
        ` /CreationDate (${pdfDate(new Date())}) >>\n`
    )
  );
  endObject();

  slices.forEach((slice, index) => {
    const id = pageId(index);
    const contentId = id + 1;
    const imageId = id + 2;
    const [width, height] = pageSize(slice);
    // Scale the unit square to the page box: the image fills the page exactly.
    const content = `q\n${width.toFixed(2)} 0 0 ${height.toFixed(2)} 0 0 cm\n/Im0 Do\nQ\n`;

    startObject(id);
    push(
      bytes(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width.toFixed(2)} ${height.toFixed(2)}] ` +
          `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\n`
      )
    );
    endObject();

    startObject(contentId);
    push(bytes(`<< /Length ${content.length} >>\nstream\n${content}endstream\n`));
    endObject();

    startObject(imageId);
    push(
      bytes(
        `<< /Type /XObject /Subtype /Image /Width ${slice.width} /Height ${slice.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
          `/Length ${slice.data.length} >>\nstream\n`
      )
    );
    push(slice.data);
    push(bytes('\nendstream\n'));
    endObject();
  });

  const count = 4 + slices.length * 3; // objects 1..3 plus three per page
  const xrefOffset = length;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id += 1) {
    xref += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  push(bytes(xref));
  push(
    bytes(
      `trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    )
  );

  return new Blob([concat(chunks)], { type: 'application/pdf' });
}

export const PDF_MODES = { SINGLE: 'single', A4: 'a4' };
