'use strict';

const listEl = document.getElementById('list');
const messageEl = document.getElementById('message');
const countEl = document.getElementById('count');

// Static markup only — never interpolated with filenames.
const FOLDER_SVG =
  '<svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">' +
  '<path d="M1 3.2c0-.66.54-1.2 1.2-1.2h3l1.4 1.4h5.2c.66 0 1.2.54 1.2 1.2v6c0 .66-.54 1.2-1.2 1.2H2.2c-.66 0-1.2-.54-1.2-1.2V3.2z"/>' +
  '</svg>';

const FILE_SVG =
  '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">' +
  '<path d="M3.5 1.6h4.4l2.6 2.6v8.2H3.5z" stroke-linejoin="round"/>' +
  '<path d="M7.9 1.6v2.6h2.6" stroke-linejoin="round"/>' +
  '</svg>';

// ── State ─────────────────────────────────────────────────

let items = [];               // current listing, index-aligned with the DOM
const selected = new Set();   // selected full paths
let anchorIndex = null;       // range-selection anchor

// ── Formatting ────────────────────────────────────────────

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// Relative for recent items, because scanning for "what did I just
// download" is the main use.
function formatDate(ms) {
  const date = new Date(ms);
  const now = new Date();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);

  if (dayDiff === 0) {
    const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `Today ${time}`;
  }
  if (dayDiff === 1) return 'Yesterday';
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

// Split so the extension can be pinned as a non-shrinking tail. A leading
// dot is already filtered out upstream, and lastIndexOf > 0 keeps names
// like "archive.tar.gz" splitting at the final dot.
function splitName(name) {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) {
    return { head: name.slice(0, dot), tail: name.slice(dot) };
  }
  return { head: name, tail: '' };
}

// ── Selection ─────────────────────────────────────────────

function syncSelectionClasses() {
  for (const row of listEl.children) {
    row.classList.toggle('selected', selected.has(row.dataset.path));
  }
}

function clearSelection() {
  if (selected.size === 0) return;
  selected.clear();
  anchorIndex = null;
  syncSelectionClasses();
}

function selectOnly(index) {
  selected.clear();
  selected.add(items[index].path);
  anchorIndex = index;
}

function selectRange(index) {
  const from = Math.min(anchorIndex, index);
  const to = Math.max(anchorIndex, index);
  selected.clear();
  for (let i = from; i <= to; i++) selected.add(items[i].path);
}

function onRowClick(event, index) {
  if (event.shiftKey && anchorIndex !== null) {
    selectRange(index);
  } else if (event.metaKey) {
    const filePath = items[index].path;
    if (selected.has(filePath)) selected.delete(filePath);
    else selected.add(filePath);
    anchorIndex = index;
  } else {
    selectOnly(index);
  }
  syncSelectionClasses();
  window.api.warmDragIcons([...selected]);
}

// ── Drag out ──────────────────────────────────────────────

function onRowDragStart(event, index) {
  // The HTML5 drag is useless here: dataTransfer cannot hand a real file to
  // another macOS app. Cancel it and let the main process run a native drag
  // via webContents.startDrag instead.
  //
  // This is NOT the blanket dragstart suppression the reference app uses to
  // protect its -webkit-app-region: drag zones. Rows deliberately sit
  // outside any drag region; this preventDefault is the documented Electron
  // handoff. See context_v2.md, "Known gotchas".
  event.preventDefault();

  // Dragging an unselected row drags just that row, and selects it so the
  // visual state matches what is being dragged.
  if (!selected.has(items[index].path)) {
    selectOnly(index);
    syncSelectionClasses();
  }

  window.api.startDrag([...selected]);
}

// ── Rendering ─────────────────────────────────────────────

function buildRow(item, index) {
  const row = document.createElement('li');
  row.className = item.isDirectory ? 'row is-dir' : 'row';
  row.dataset.path = item.path;
  row.draggable = true;

  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.innerHTML = item.isDirectory ? FOLDER_SVG : FILE_SVG;

  const name = document.createElement('span');
  name.className = 'name';
  name.title = item.name;
  const parts = splitName(item.name);

  const head = document.createElement('span');
  head.className = 'name-head';
  head.textContent = parts.head; // textContent, never innerHTML: filenames are untrusted

  const tail = document.createElement('span');
  tail.className = 'name-tail';
  tail.textContent = parts.tail;

  name.append(head, tail);

  const date = document.createElement('span');
  date.className = 'date';
  date.textContent = formatDate(item.modified);

  row.append(icon, name, date);

  row.addEventListener('click', (event) => onRowClick(event, index));
  row.addEventListener('dragstart', (event) => onRowDragStart(event, index));
  // Warm the icon before the drag begins, so a single-file drag shows the
  // real macOS file icon rather than the generic fallback.
  row.addEventListener('mouseenter', () => window.api.warmDragIcons([item.path]));

  return row;
}

function showMessage(text) {
  listEl.hidden = true;
  messageEl.hidden = false;
  messageEl.textContent = text;
  countEl.textContent = '';
}

function errorText(code) {
  if (code === 'EACCES' || code === 'EPERM') {
    return 'macOS is blocking access to Downloads.\nGrant permission in System Settings → Privacy & Security → Files and Folders.';
  }
  if (code === 'ENOENT') return 'No Downloads folder found.';
  if (code === 'ENOTDIR') return 'Downloads is not a folder.';
  return `Could not read Downloads (${code}).`;
}

function render(result) {
  // The listing is rebuilt from scratch, so stale selections cannot survive.
  selected.clear();
  anchorIndex = null;

  if (!result || !result.ok) {
    items = [];
    showMessage(errorText(result ? result.code : 'UNKNOWN'));
    return;
  }

  items = result.items;

  if (items.length === 0) {
    showMessage('Downloads is empty.');
    return;
  }

  const fragment = document.createDocumentFragment();
  items.forEach((item, index) => fragment.append(buildRow(item, index)));

  listEl.replaceChildren(fragment);
  listEl.hidden = false;
  messageEl.hidden = true;
  countEl.textContent = String(items.length);
}

// ── Wiring ────────────────────────────────────────────────

async function refresh() {
  try {
    render(await window.api.listDownloads());
  } catch (err) {
    console.error('[renderer] listDownloads failed:', err);
    showMessage('Could not read Downloads.');
  }
}

// Clicking the list's own padding, rather than a row, clears the selection.
listEl.addEventListener('click', (event) => {
  if (event.target === listEl) clearSelection();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') clearSelection();
});

refresh();
window.api.onPanelShown(refresh);
