/**
 * Paint one distinct colour per row: rgb(y >> 16, (y >> 8) & 255, y & 255).
 * Decoding the left strip of a stitched screenshot therefore yields the exact
 * document Y of every row — the ground truth the E2E check compares against.
 */
const HEIGHT = Number(new URLSearchParams(location.search).get('h') || 5000);

const canvas = document.getElementById('probe');
canvas.height = HEIGHT;
canvas.style.width = '60px';
canvas.style.height = `${HEIGHT}px`;

const ctx = canvas.getContext('2d');
const image = ctx.createImageData(canvas.width, HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const r = (y >> 16) & 255;
  const g = (y >> 8) & 255;
  const b = y & 255;
  for (let x = 0; x < canvas.width; x += 1) {
    const i = (y * canvas.width + x) * 4;
    image.data[i] = r;
    image.data[i + 1] = g;
    image.data[i + 2] = b;
    image.data[i + 3] = 255;
  }
}
ctx.putImageData(image, 0, 0);

// Text content next to the strip, so the page also has ordinary reflowable content.
const filler = document.getElementById('filler');
for (let y = 0; y < HEIGHT; y += 200) {
  const row = document.createElement('div');
  row.style.height = '200px';
  row.textContent = `document offset ${y}px`;
  filler.appendChild(row);
}
document.body.style.height = `${HEIGHT}px`;
