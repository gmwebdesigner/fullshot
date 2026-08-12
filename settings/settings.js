import { APP_NAME, DEFAULT_SETTINGS } from '../shared/constants.js';
import { getSettings, saveSettings, resetSettings } from '../shared/storage.js';
import { buildFilename } from '../shared/utils.js';

const $ = (id) => document.getElementById(id);

const FIELDS = {
  format: 'value',
  jpgQuality: 'value',
  delay: 'value',
  filenameTemplate: 'value',
  hideFixed: 'checked',
  clientFooter: 'checked'
};

document.getElementById('app-name').textContent = APP_NAME;
document.title = `${APP_NAME} — settings`;

function apply(settings) {
  for (const [key, prop] of Object.entries(FIELDS)) {
    $(key)[prop] = prop === 'checked' ? Boolean(settings[key]) : String(settings[key]);
  }
  updatePreview();
}

function readForm() {
  const patch = {};
  for (const [key, prop] of Object.entries(FIELDS)) {
    const raw = $(key)[prop];
    patch[key] = key === 'jpgQuality' ? Number(raw) : raw;
  }
  // An empty or all-invalid template would produce a nameless file.
  if (!String(patch.filenameTemplate).trim()) {
    patch.filenameTemplate = DEFAULT_SETTINGS.filenameTemplate;
  }
  return patch;
}

function updatePreview() {
  const template = $('filenameTemplate').value || DEFAULT_SETTINGS.filenameTemplate;
  $('filename-preview').textContent = buildFilename(template, {
    url: 'https://www.example.com/pricing',
    title: 'Pricing — Example',
    extension: $('format').value === 'jpg' ? 'jpg' : 'png'
  });
}

let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveSettings(readForm());
    $('status').textContent = 'Saved';
    setTimeout(() => ($('status').textContent = ''), 1400);
  }, 220);
}

for (const key of Object.keys(FIELDS)) {
  $(key).addEventListener('input', () => {
    updatePreview();
    scheduleSave();
  });
  $(key).addEventListener('change', () => {
    updatePreview();
    scheduleSave();
  });
}

$('reset').addEventListener('click', async () => {
  apply(await resetSettings());
  $('status').textContent = 'Reset to defaults';
  setTimeout(() => ($('status').textContent = ''), 1400);
});

// chrome://extensions/shortcuts cannot be opened with chrome.tabs.create from
// a content-script context, but an extension page is allowed to.
$('open-shortcuts').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

(async () => {
  apply(await getSettings());
  const commands = await chrome.commands.getAll();
  const full = commands.find((command) => command.name === 'capture-full-page');
  $('shortcut-line').textContent = full?.shortcut
    ? `Full page capture: ${full.shortcut}`
    : 'No shortcut is currently assigned to the full page capture.';
})();
