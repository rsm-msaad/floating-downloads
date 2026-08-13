'use strict';

const columnsEl = document.getElementById('columns');
const messageEl = document.getElementById('message');
const countEl = document.getElementById('count');
const tabsEl = document.getElementById('tabs');

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
// One entry per open column, left to right.
//   path      absolute directory path this column lists
//   items     entries, newest first
//   selected  Set of selected paths — only ever non-empty in ONE column,
//             because selection does not span columns
//   anchor    index for shift-range selection
//   openChild path of the folder in THIS column that opened the next one,
//             drawn with the dimmer "path" highlight so the trail through
//             the columns stays readable
let columns = [];

// Quick Look is an external qlmanage process. This tracks whether we believe
// it is open, so Space can toggle and Escape can claim the keypress.
let quickLookOpen = false;

// The allowed roots, and which one the column trail currently belongs to.
let roots = [];
let activeRootKey = null;

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

function clearAllSelections() {
  for (const column of columns) {
    column.selected.clear();
    column.anchor = null;
  }
}

// Selection does not span columns, but Cmd- and Shift-click must be able to
// extend the selection within their own column — so clear every OTHER one.
function clearSelectionsExcept(keepIndex) {
  columns.forEach((column, columnIndex) => {
    if (columnIndex === keepIndex) return;
    column.selected.clear();
    column.anchor = null;
  });
}

function syncSelectionClasses() {
  columns.forEach((column, columnIndex) => {
    const columnEl = columnsEl.children[columnIndex];
    if (!columnEl) return;
    for (const row of columnEl.children) {
      row.classList.toggle('selected', column.selected.has(row.dataset.path));
      row.classList.toggle('path', column.openChild === row.dataset.path);
    }
  });
}

function updateCount() {
  const active = columns[columns.length - 1];
  countEl.textContent = active ? String(active.items.length) : '';
}

// ── Columns ───────────────────────────────────────────────

function truncateColumnsAfter(columnIndex) {
  if (columns.length > columnIndex + 1) {
    columns.length = columnIndex + 1;
    columns[columnIndex].openChild = null;
    while (columnsEl.children.length > columnIndex + 1) {
      columnsEl.lastElementChild.remove();
    }
  }
}

async function openFolder(columnIndex, item) {
  const result = await window.api.readDir(item.path);
  if (!result.ok) {
    // A folder that vanished or is blocked: leave the column trail as it is
    // and report it, rather than opening an empty mystery column.
    console.error(`[columns] cannot open ${item.name}: ${result.code}`);
    return;
  }

  columns[columnIndex].openChild = item.path;
  columns.push({
    path: result.dir,
    items: result.items,
    selected: new Set(),
    anchor: null,
    openChild: null
  });

  columnsEl.append(buildColumn(columns.length - 1));
  syncSelectionClasses();
  updateCount();

  // Auto-scroll so the newest column is visible. The panel deliberately does
  // not widen itself; the user resizes as they see fit.
  columnsEl.scrollLeft = columnsEl.scrollWidth;
}

function onRowClick(event, columnIndex, rowIndex) {
  const column = columns[columnIndex];
  const item = column.items[rowIndex];

  // Selection never spans columns — but this column's own selection has to
  // survive, or Cmd/Shift could never extend it.
  clearSelectionsExcept(columnIndex);

  const isRange = event.shiftKey && column.anchor !== null;
  const isToggle = event.metaKey;

  if (isRange) {
    column.selected.clear();
    const from = Math.min(column.anchor, rowIndex);
    const to = Math.max(column.anchor, rowIndex);
    for (let i = from; i <= to; i++) column.selected.add(column.items[i].path);
  } else if (isToggle) {
    if (column.selected.has(item.path)) column.selected.delete(item.path);
    else column.selected.add(item.path);
    column.anchor = rowIndex;
  } else {
    column.selected.clear();
    column.selected.add(item.path);
    column.anchor = rowIndex;
  }

  // Any click in a column invalidates everything to its right: the folder
  // that opened those columns is no longer the selected one.
  truncateColumnsAfter(columnIndex);

  // Only a plain click on a single folder drills in. A multi-select is
  // ambiguous about which folder to open, so it just selects.
  if (item.isDirectory && !isRange && !isToggle) {
    syncSelectionClasses();
    openFolder(columnIndex, item);
  } else {
    syncSelectionClasses();
    updateCount();
  }

  window.api.warmDragIcons([...column.selected]);
}

// Select a single row without any modifier semantics — used by right-click
// on a row outside the current selection.
function selectSingle(columnIndex, rowIndex) {
  clearAllSelections();
  const column = columns[columnIndex];
  column.selected.add(column.items[rowIndex].path);
  column.anchor = rowIndex;
  syncSelectionClasses();
}

function onRowDoubleClick(columnIndex, rowIndex) {
  const item = columns[columnIndex].items[rowIndex];
  // A folder is already drilled into by the preceding single click, and
  // re-opening would discard and rebuild the identical column. Folders are
  // never opened in Finder.
  if (item.isDirectory) return;
  window.api.openFile(item.path);
}

function onRowContextMenu(event, columnIndex, rowIndex) {
  event.preventDefault();
  const column = columns[columnIndex];
  const item = column.items[rowIndex];

  // Right-clicking inside the selection keeps it and acts on all of it;
  // right-clicking outside selects that row first.
  if (!column.selected.has(item.path)) selectSingle(columnIndex, rowIndex);

  window.api.showContextMenu([...column.selected]);
}

// ── Quick Look ────────────────────────────────────────────

function selectedPaths() {
  for (const column of columns) {
    if (column.selected.size > 0) return [...column.selected];
  }
  return [];
}

function toggleQuickLook() {
  if (quickLookOpen) {
    window.api.dismissQuickLook();
    quickLookOpen = false;
    return;
  }
  const paths = selectedPaths();
  if (paths.length === 0) return;
  window.api.quickLook(paths);
  quickLookOpen = true;
}

function onRowDragStart(event, columnIndex, rowIndex) {
  // The HTML5 drag is useless here: dataTransfer cannot hand a real file to
  // another macOS app. Cancel it and let the main process run a native drag
  // via webContents.startDrag instead.
  //
  // This is NOT the blanket dragstart suppression the reference app uses to
  // protect its -webkit-app-region: drag zones. Rows deliberately sit
  // outside any drag region; this preventDefault is the documented Electron
  // handoff. See context_v2.md, "Known gotchas".
  event.preventDefault();

  const column = columns[columnIndex];
  const item = column.items[rowIndex];

  // Dragging an unselected row drags just that row, in its own column.
  if (!column.selected.has(item.path)) {
    clearAllSelections();
    column.selected.add(item.path);
    column.anchor = rowIndex;
    syncSelectionClasses();
  }

  window.api.startDrag([...column.selected]);
}

// ── Rendering ─────────────────────────────────────────────

function buildRow(item, columnIndex, rowIndex) {
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

  row.addEventListener('click', (event) => onRowClick(event, columnIndex, rowIndex));
  row.addEventListener('dblclick', () => onRowDoubleClick(columnIndex, rowIndex));
  row.addEventListener('contextmenu', (event) => onRowContextMenu(event, columnIndex, rowIndex));
  row.addEventListener('dragstart', (event) => onRowDragStart(event, columnIndex, rowIndex));
  // Warm the icon before the drag begins, so a single-file drag shows the
  // real macOS file icon rather than the generic fallback.
  row.addEventListener('mouseenter', () => window.api.warmDragIcons([item.path]));

  return row;
}

function buildColumn(columnIndex) {
  const column = columns[columnIndex];
  const columnEl = document.createElement('ul');
  columnEl.className = 'column';
  columnEl.dataset.index = String(columnIndex);

  // Clicking a column's own padding, rather than a row, clears the selection.
  columnEl.addEventListener('click', (event) => {
    if (event.target === columnEl) {
      clearAllSelections();
      syncSelectionClasses();
    }
  });

  if (column.items.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'column-empty';
    empty.textContent = columnIndex === 0 ? 'Downloads is empty.' : 'Empty folder.';
    columnEl.append(empty);
    return columnEl;
  }

  const fragment = document.createDocumentFragment();
  column.items.forEach((item, rowIndex) => {
    fragment.append(buildRow(item, columnIndex, rowIndex));
  });
  columnEl.append(fragment);
  return columnEl;
}

function renderColumns() {
  const fragment = document.createDocumentFragment();
  columns.forEach((_, columnIndex) => fragment.append(buildColumn(columnIndex)));
  columnsEl.replaceChildren(fragment);
  columnsEl.hidden = false;
  messageEl.hidden = true;
  syncSelectionClasses();
  updateCount();
}

function showMessage(text) {
  columnsEl.hidden = true;
  messageEl.hidden = false;
  messageEl.textContent = text;
  countEl.textContent = '';
}

function errorText(code) {
  if (code === 'EACCES' || code === 'EPERM') {
    return 'macOS is blocking access to Downloads.\nGrant permission in System Settings → Privacy & Security → Files and Folders.';
  }
  if (code === 'ENOENT' || code === 'ENOROOT') return 'No Downloads folder found.';
  if (code === 'ENOTDIR') return 'Downloads is not a folder.';
  if (code === 'EOUTSIDE') return 'That folder is outside Downloads.';
  return `Could not read Downloads (${code}).`;
}

// ── Navigation ────────────────────────────────────────────

function closeRightmostColumn() {
  if (columns.length <= 1) return false;
  columns.pop();
  columns[columns.length - 1].openChild = null;
  columnsEl.lastElementChild.remove();
  clearAllSelections();
  syncSelectionClasses();
  updateCount();
  columnsEl.scrollLeft = columnsEl.scrollWidth;
  return true;
}

// ── Wiring ────────────────────────────────────────────────

// ── Roots ─────────────────────────────────────────────────

function activeRoot() {
  return roots.find((root) => root.key === activeRootKey) || roots[0] || null;
}

function syncTabClasses() {
  for (const button of tabsEl.children) {
    button.classList.toggle('active', button.dataset.key === activeRootKey);
  }
}

async function switchRoot(key) {
  if (key === activeRootKey) return;
  activeRootKey = key;
  syncTabClasses();
  window.api.setActiveRoot(key);
  // The trail belongs to the old root, so it is discarded rather than
  // preserved per tab.
  columns = [];
  await refresh();
}

function buildTabs() {
  const fragment = document.createDocumentFragment();
  for (const root of roots) {
    const button = document.createElement('button');
    button.className = 'tab';
    button.dataset.key = root.key;
    button.textContent = root.label;
    button.addEventListener('click', () => switchRoot(root.key));
    fragment.append(button);
  }
  tabsEl.replaceChildren(fragment);
  syncTabClasses();
}

// Re-read every open column so the trail survives a hide/show. If a column's
// folder has gone, the trail is truncated there rather than showing stale
// contents.
async function refresh() {
  const root = activeRoot();
  const paths = columns.length ? columns.map((column) => column.path) : [root ? root.path : null];
  const rebuilt = [];
  let firstError = null;

  for (const dirPath of paths) {
    let result;
    try {
      result = await window.api.readDir(dirPath);
    } catch (err) {
      console.error('[renderer] readDir failed:', err);
      result = { ok: false, code: 'UNKNOWN' };
    }
    if (!result.ok) {
      if (rebuilt.length === 0) firstError = result.code;
      break;
    }
    rebuilt.push({
      path: result.dir,
      items: result.items,
      selected: new Set(),
      anchor: null,
      openChild: null
    });
  }

  if (rebuilt.length === 0) {
    columns = [];
    showMessage(errorText(firstError || 'UNKNOWN'));
    return;
  }

  for (let i = 0; i < rebuilt.length - 1; i++) rebuilt[i].openChild = rebuilt[i + 1].path;
  columns = rebuilt;
  renderColumns();
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    // Resolution order matters: Quick Look first, then step back a column,
    // then clear the selection.
    if (quickLookOpen) {
      window.api.dismissQuickLook();
      quickLookOpen = false;
      return;
    }
    if (closeRightmostColumn()) return;
    clearAllSelections();
    syncSelectionClasses();
    return;
  }

  if (event.key === 'Backspace') {
    event.preventDefault();
    closeRightmostColumn();
    return;
  }

  if (event.key === ' ') {
    // Otherwise Space scrolls the column.
    event.preventDefault();
    toggleQuickLook();
  }
});

// qlmanage can be closed from outside the app; without this the next Space
// would try to dismiss a panel that has already gone.
window.api.onQuickLookClosed(() => { quickLookOpen = false; });

window.api.onFilesChanged(refresh);

async function init() {
  try {
    const result = await window.api.listRoots();
    roots = result.roots || [];
    activeRootKey = result.activeRoot;
  } catch (err) {
    console.error('[renderer] listRoots failed:', err);
    roots = [];
  }
  if (roots.length === 0) {
    showMessage('No readable folders found.');
    return;
  }
  // A persisted root that no longer resolves falls back to the first one.
  if (!roots.some((root) => root.key === activeRootKey)) activeRootKey = roots[0].key;
  buildTabs();
  await refresh();
}

init();
window.api.onPanelShown(refresh);
