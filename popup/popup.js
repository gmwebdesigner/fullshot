import { APP_NAME, MSG, MODE } from '../shared/constants.js';
import { domainOf, tabBlockReason } from '../shared/utils.js';

const LAST_MODE_KEY = 'fullshot.lastMode';

const captureButton = document.getElementById('capture');
const statusEl = document.getElementById('status');
const hostEl = document.getElementById('page-host');
const shortcutEl = document.getElementById('shortcut');

document.getElementById('app-name').textContent = APP_NAME;
document.title = APP_NAME;

const LABELS = {
  [MODE.FULL]: 'Capture full page',
  [MODE.VISIBLE]: 'Capture visible area',
  [MODE.AREA]: 'Select area'
};

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function setStatus(text, tone = '') {
  statusEl.textContent = text;
  if (tone) statusEl.dataset.tone = tone;
  else delete statusEl.dataset.tone;
}

function syncLabel() {
  captureButton.textContent = LABELS[selectedMode()];
}

for (const input of document.querySelectorAll('input[name="mode"]')) {
  input.addEventListener('change', () => {
    syncLabel();
    chrome.storage.local.set({ [LAST_MODE_KEY]: selectedMode() });
  });
}

document.getElementById('settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

captureButton.addEventListener('click', async () => {
  captureButton.disabled = true;
  setStatus('Capturing…');
  try {
    const result = await chrome.runtime.sendMessage({
      type: MSG.CAPTURE_START,
      mode: selectedMode()
    });
    if (result?.cancelled) {
      setStatus('Capture cancelled.');
    } else if (result?.ok === false || result?.error) {
      setStatus(result.error || 'The capture failed.', 'error');
    } else {
      // The result tab opens and the popup closes with it.
      window.close();
    }
  } catch (error) {
    setStatus(String(error?.message || error), 'error');
  } finally {
    captureButton.disabled = false;
  }
});

/* ---- initial state -------------------------------------------------------- */

(async () => {
  const stored = await chrome.storage.local.get(LAST_MODE_KEY);
  const last = stored[LAST_MODE_KEY];
  const input = last && document.querySelector(`input[name="mode"][value="${last}"]`);
  if (input) input.checked = true;
  syncLabel();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  hostEl.textContent = tab?.url ? domainOf(tab.url) : 'Capture this page';

  const reason = tabBlockReason(tab);
  if (reason) {
    captureButton.disabled = true;
    setStatus(reason, 'error');
  }

  const commands = await chrome.commands.getAll();
  const full = commands.find((command) => command.name === 'capture-full-page');
  shortcutEl.textContent = full?.shortcut || 'not set';
})();
