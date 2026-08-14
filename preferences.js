'use strict';

// Renderer for the Preferences window. It captures a key combination and
// hands it to the main process, which owns registration and persistence.

const recorderEl = document.getElementById('recorder');
const statusEl = document.getElementById('status');
const resetEl = document.getElementById('reset');
const closeEl = document.getElementById('close');

let currentHotkey = null;
let defaultHotkey = null;
let recording = false;

// ── Accelerator <-> display ───────────────────────────────

const SYMBOLS = {
  CommandOrControl: '⌘',
  Command: '⌘',
  Control: '⌃',
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧'
};

// Modifier order matches how macOS prints them: ⌃⌥⇧⌘.
const DISPLAY_ORDER = ['Control', 'Alt', 'Option', 'Shift', 'CommandOrControl', 'Command'];

function toDisplay(accelerator) {
  if (!accelerator) return '';
  const parts = accelerator.split('+');
  const modifiers = parts.filter((part) => SYMBOLS[part]);
  const keys = parts.filter((part) => !SYMBOLS[part]);
  modifiers.sort((a, b) => DISPLAY_ORDER.indexOf(a) - DISPLAY_ORDER.indexOf(b));
  return modifiers.map((m) => SYMBOLS[m]).join('') + keys.join('+');
}

// event.code rather than event.key: the physical key is stable regardless of
// which modifiers are held, so Shift+2 records as "2" and not "@".
function keyFromCode(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;

  const named = {
    Space: 'Space', Tab: 'Tab', Enter: 'Return', NumpadEnter: 'Return',
    Backspace: 'Backspace', Delete: 'Delete',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: '\'', Comma: ',',
    Period: '.', Slash: '/', Backquote: '`'
  };
  return named[code] || null;
}

function toAccelerator(event) {
  const modifiers = [];
  if (event.metaKey) modifiers.push('CommandOrControl');
  if (event.ctrlKey) modifiers.push('Control');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');

  const key = keyFromCode(event.code);
  if (!key) return null;                    // modifier-only press
  if (modifiers.length === 0) return null;  // a bare key would fire constantly

  return [...modifiers, key].join('+');
}

// ── UI ────────────────────────────────────────────────────

function setStatus(text, kind) {
  statusEl.textContent = text || '';
  statusEl.className = `status${kind ? ` ${kind}` : ''}`;
}

function render() {
  recorderEl.textContent = recording ? 'Press a combination…' : toDisplay(currentHotkey);
  recorderEl.classList.toggle('recording', recording);
}

function startRecording() {
  if (recording) return;
  recording = true;
  setStatus('');
  render();
  recorderEl.focus();
}

function stopRecording() {
  recording = false;
  render();
}

async function commit(accelerator) {
  const result = await window.api.setHotkey(accelerator);
  currentHotkey = result.hotkey;
  stopRecording();
  if (result.ok) setStatus(`Shortcut set to ${toDisplay(result.hotkey)}.`, 'ok');
  else setStatus(result.error, 'error');
}

recorderEl.addEventListener('click', startRecording);

recorderEl.addEventListener('keydown', async (event) => {
  if (!recording) {
    // Space/Enter activate the button normally.
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      startRecording();
    }
    return;
  }

  // Never let a captured combination reach the page.
  event.preventDefault();
  event.stopPropagation();

  if (event.key === 'Escape') {
    // Cancel without changing anything.
    stopRecording();
    setStatus('Cancelled. Shortcut unchanged.');
    return;
  }

  const accelerator = toAccelerator(event);
  if (!accelerator) {
    // Modifier-only, or no modifier at all: keep waiting rather than
    // recording something unusable.
    return;
  }

  await commit(accelerator);
});

// Clicking away from a half-finished recording should not leave it armed.
recorderEl.addEventListener('blur', () => {
  if (recording) {
    stopRecording();
    setStatus('Cancelled. Shortcut unchanged.');
  }
});

resetEl.addEventListener('click', async () => {
  const result = await window.api.resetHotkey();
  currentHotkey = result.hotkey;
  stopRecording();
  if (result.ok) setStatus(`Reset to ${toDisplay(result.hotkey)}.`, 'ok');
  else setStatus(result.error, 'error');
});

closeEl.addEventListener('click', () => window.api.closePrefs());

async function init() {
  const prefs = await window.api.getPrefs();
  currentHotkey = prefs.hotkey;
  defaultHotkey = prefs.defaultHotkey;
  render();
  if (currentHotkey !== defaultHotkey) {
    setStatus(`Default is ${toDisplay(defaultHotkey)}.`);
  }
}

init();
