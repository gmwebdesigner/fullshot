// Lazy images: inline SVG data URLs, so the test page works offline.
const svg = (label, hue) =>
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="360">
       <rect width="600" height="360" fill="hsl(${hue} 70% 88%)"/>
       <circle cx="300" cy="180" r="90" fill="hsl(${hue} 70% 62%)"/>
       <text x="300" y="330" text-anchor="middle" font-family="system-ui"
             font-size="28" fill="hsl(${hue} 40% 30%)">${label}</text>
     </svg>`
  );

const grid = document.getElementById('lazy-grid');
for (let i = 1; i <= 6; i += 1) {
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = `Lazy image ${i}`;
  img.src = svg(`lazy ${i}`, i * 47);
  grid.appendChild(img);
}

// A ruler, so a duplicated or missing band is immediately obvious.
const ruler = document.getElementById('ruler');
for (let y = 0; y <= 2000; y += 100) {
  const row = document.createElement('div');
  row.textContent = `${y} px`;
  row.style.cssText =
    'height:100px;border-top:1px dashed #d4d4d8;color:#a1a1aa;font-variant-numeric:tabular-nums';
  ruler.appendChild(row);
}

const observer = new IntersectionObserver(
  (entries) => entries.forEach((entry) => entry.isIntersecting && entry.target.classList.add('in')),
  { threshold: 0.2 }
);
document.querySelectorAll('.reveal').forEach((element) => observer.observe(element));

// Cookie banner dismiss (an inline onclick would be blocked by the extension CSP
// if this file is opened from a chrome-extension:// URL).
document.getElementById('cookie-accept').addEventListener('click', () => {
  document.getElementById('cookies').remove();
});

// A third-party-style widget inside an OPEN SHADOW ROOT — an accessibility
// toolbar, a chat bubble, a consent bar. querySelectorAll does not cross a
// shadow boundary, so a fixed element in here is invisible to a naive scan and
// repeats in every captured section. Regression guard for that traversal.
const shadowHost = document.createElement('div');
document.body.appendChild(shadowHost);
shadowHost.attachShadow({ mode: 'open' }).innerHTML =
  '<div style="position:fixed;left:24px;top:50%;width:56px;height:56px;' +
  'border-radius:16px;background:#ff00ff;z-index:70"></div>';

// A bar that only becomes fixed once the page has been scrolled — Google's
// results header, most "shrink on scroll" navbars. It is not fixed when the
// capture starts, so a single scan up front never sees it. It must not appear
// in the image at all: it never belonged to any one place in the document.
const lateBar = document.createElement('div');
lateBar.style.cssText =
  'display:none;position:fixed;top:0;left:0;right:0;height:48px;background:#00ffff;z-index:80';
document.body.appendChild(lateBar);
addEventListener('scroll', () => {
  lateBar.style.display = scrollY > 1500 ? 'block' : 'none';
});
