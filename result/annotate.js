/**
 * FullShot — annotation model and renderer.
 *
 * Annotations are stored in *image* coordinates, never in screen coordinates,
 * so the same list renders identically in the scaled-down preview and in the
 * full resolution export. That is the whole trick: one renderer, two scales.
 */

export const TOOLS = ['arrow', 'rect', 'blur', 'text'];

/** Stroke width that looks the same on a 900px and on a 3000px wide capture. */
export function baseStroke(imageWidth) {
  return Math.max(2, Math.round(imageWidth / 400));
}

function drawArrow(ctx, a, unit) {
  const { x1, y1, x2, y2, color } = a;
  const width = unit * 1.4;
  const head = Math.max(unit * 5, 10);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const backX = x2 - Math.cos(angle) * head * 0.85;
  const backY = y2 - Math.sin(angle) * head * 0.85;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(backX, backY);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(backX - Math.sin(angle) * head * 0.45, backY + Math.cos(angle) * head * 0.45);
  ctx.lineTo(backX + Math.sin(angle) * head * 0.45, backY - Math.cos(angle) * head * 0.45);
  ctx.closePath();
  ctx.fill();
}

function drawRect(ctx, a, unit) {
  const x = Math.min(a.x1, a.x2);
  const y = Math.min(a.y1, a.y2);
  const w = Math.abs(a.x2 - a.x1);
  const h = Math.abs(a.y2 - a.y1);
  ctx.strokeStyle = a.color;
  ctx.lineWidth = unit * 1.2;
  ctx.lineJoin = 'round';
  ctx.strokeRect(x, y, w, h);
}

function drawText(ctx, a, unit) {
  const size = Math.max(unit * 7, 14);
  ctx.font = `600 ${size}px Inter, system-ui, -apple-system, sans-serif`;
  ctx.textBaseline = 'top';
  // A dark halo keeps the label readable on any background.
  ctx.lineWidth = Math.max(2, size / 8);
  ctx.strokeStyle = 'rgba(0,0,0,.55)';
  ctx.strokeText(a.text, a.x1, a.y1);
  ctx.fillStyle = a.color;
  ctx.fillText(a.text, a.x1, a.y1);
}

/**
 * Blur a rectangle by redrawing that part of the source image through a canvas
 * filter, clipped to the rectangle. The source is sampled with padding so the
 * blur has real pixels to pull from and the edges do not fade to transparent.
 */
function drawBlur(ctx, a, source, scale) {
  const x = Math.min(a.x1, a.x2);
  const y = Math.min(a.y1, a.y2);
  const w = Math.abs(a.x2 - a.x1);
  const h = Math.abs(a.y2 - a.y1);
  if (w < 2 || h < 2) return;

  const radius = Math.max(6, Math.round(Math.min(w, h) / 8));
  const pad = radius * 2;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x * scale, y * scale, w * scale, h * scale);
  ctx.clip();
  ctx.filter = `blur(${radius * scale}px)`;
  ctx.drawImage(
    source,
    Math.max(0, x - pad),
    Math.max(0, y - pad),
    Math.min(source.width, w + pad * 2),
    Math.min(source.height, h + pad * 2),
    Math.max(0, x - pad) * scale,
    Math.max(0, y - pad) * scale,
    Math.min(source.width, w + pad * 2) * scale,
    Math.min(source.height, h + pad * 2) * scale
  );
  ctx.restore();
  ctx.filter = 'none';
}

/**
 * Draw the image plus every annotation into `ctx`.
 * @param scale 1 for export, <1 for the preview.
 */
export function render(ctx, source, annotations, scale) {
  ctx.filter = 'none';
  ctx.drawImage(source, 0, 0, source.width * scale, source.height * scale);

  const unit = baseStroke(source.width) * scale;

  for (const a of annotations) {
    if (a.type === 'blur') {
      drawBlur(ctx, a, source, scale);
      continue;
    }
    ctx.save();
    ctx.scale(scale, scale);
    const scaledUnit = unit / scale;
    if (a.type === 'arrow') drawArrow(ctx, a, scaledUnit);
    else if (a.type === 'rect') drawRect(ctx, a, scaledUnit);
    else if (a.type === 'text') drawText(ctx, a, scaledUnit);
    ctx.restore();
  }
}

/**
 * Paint a metadata strip under the screenshot — the "Copy for client" bar.
 * Returns the bar height in image pixels so callers can size their canvas.
 */
export function footerHeight(imageWidth) {
  return Math.round(Math.min(110, Math.max(58, imageWidth * 0.05)));
}

export function drawFooter(ctx, imageWidth, top, { url, date, viewport }) {
  const height = footerHeight(imageWidth);
  const padding = Math.round(height * 0.32);
  const primary = Math.round(height * 0.3);
  const secondary = Math.round(height * 0.24);

  ctx.fillStyle = '#18181b';
  ctx.fillRect(0, top, imageWidth, height);

  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fafafa';
  ctx.font = `600 ${primary}px Inter, system-ui, -apple-system, sans-serif`;
  const label = url.length > 90 ? `${url.slice(0, 88)}…` : url;
  ctx.fillText(label, padding, top + height * 0.38);

  ctx.fillStyle = '#a1a1aa';
  ctx.font = `400 ${secondary}px Inter, system-ui, -apple-system, sans-serif`;
  ctx.fillText(`${date}  ·  viewport ${viewport}`, padding, top + height * 0.72);
}
