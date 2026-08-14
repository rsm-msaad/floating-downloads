'use strict';

const columnsEl = document.getElementById('columns');
const messageEl = document.getElementById('message');
const countEl = document.getElementById('count');
const tabsEl = document.getElementById('tabs');
const toastEl = document.getElementById('toast');
const popoverEl = document.getElementById('popover');
const tooltipEl = document.getElementById('tooltip');

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

// What the separate preview window is currently showing, so Arrow Up/Down
// can walk the column without closing it. This is a belief about another
// window, kept in sync by the main process — never a handle to it.
let previewOpen = false;
let previewColumnIndex = null;
let previewRowIndex = null;

// The allowed roots, and which one the column trail currently belongs to.
let roots = [];
let activeRootKey = null;

// Explicit tag colours, keyed by tag name, and the fixed palette they come
// from. The palette is fetched from the main process so the two cannot
// disagree about which colours are valid.
let tagColorMap = {};
let tagPalette = [];

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
    syncWatchers();
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

  if (result.tagColors) tagColorMap = result.tagColors;
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
  syncWatchers();

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

  window.api.showContextMenu([...column.selected], column.path);
}

// ── Preview ──────────────────────────────────────────────
// The preview is a separate floating window owned by the main process. This
// side owns only the column/selection state and decides WHAT to preview; it
// never touches any window's visibility.

// First selected row in visual order, across whichever column holds the
// selection. Multi-selection previews the first item only.
function firstSelectedLocation() {
  for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
    const column = columns[columnIndex];
    if (column.selected.size === 0) continue;
    for (let rowIndex = 0; rowIndex < column.items.length; rowIndex++) {
      if (column.selected.has(column.items[rowIndex].path)) return { columnIndex, rowIndex };
    }
  }
  return null;
}

function showPreview(columnIndex, rowIndex) {
  const column = columns[columnIndex];
  if (!column) return;
  const item = column.items[rowIndex];
  // Folders preview too, as a summary card — the main process decides which
  // kind of card to build.
  if (!item) return;

  previewColumnIndex = columnIndex;
  previewRowIndex = rowIndex;
  previewOpen = true;
  window.api.showPreview(item.path);
}

function closePreview() {
  if (!previewOpen) return;
  previewOpen = false;
  previewColumnIndex = null;
  previewRowIndex = null;
  window.api.closePreview();
}

function togglePreview() {
  if (previewOpen) {
    closePreview();
    return;
  }
  const location = firstSelectedLocation();
  if (location) showPreview(location.columnIndex, location.rowIndex);
}

// Walk to the previous/next row in the same column and update the open
// preview in place. Files and folders are both previewable, so nothing is
// skipped and the card type switches as needed.
function stepPreview(delta) {
  if (!previewOpen || previewColumnIndex === null) return;
  const column = columns[previewColumnIndex];
  if (!column) return;

  const next = previewRowIndex + delta;
  if (next < 0 || next >= column.items.length) return;

  selectSingle(previewColumnIndex, next);
  showPreview(previewColumnIndex, next);
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

  const noteMarker = markerButton('note-marker', NOTE_SVG, 'Note', (event) => {
    event.stopPropagation();
    openNotePopover(item.path, row);
  });

  const pinMarker = markerButton('pin-marker', PIN_SVG, item.pinned ? 'Unpin' : 'Pin', async (event) => {
    event.stopPropagation();
    await window.api.togglePin(item.path);
  });

  const main = document.createElement('div');
  main.className = 'row-main';
  main.append(icon, name, noteMarker, pinMarker, date);
  row.append(main);

  if (item.hasNote) row.classList.add('has-note');
  if (item.pinned) row.classList.add('is-pinned');

  // Tags get their own line, so they never compete with the filename for
  // width. At most three pills plus a +N chip; the strip clips rather than
  // wrapping to a third line.
  if (item.tags && item.tags.length > 0) {
    const strip = document.createElement('div');
    strip.className = 'tags';
    for (const tag of item.tags.slice(0, MAX_VISIBLE_TAGS)) strip.append(buildPill(tag));
    if (item.tags.length > MAX_VISIBLE_TAGS) {
      const more = document.createElement('span');
      more.className = 'pill more';
      more.textContent = `+${item.tags.length - MAX_VISIBLE_TAGS}`;
      strip.append(more);
    }
    row.append(strip);
  }

  row.addEventListener('click', (event) => onRowClick(event, columnIndex, rowIndex));
  row.addEventListener('dblclick', () => onRowDoubleClick(columnIndex, rowIndex));
  row.addEventListener('contextmenu', (event) => onRowContextMenu(event, columnIndex, rowIndex));
  row.addEventListener('dragstart', (event) => onRowDragStart(event, columnIndex, rowIndex));
  // Warm the icon before the drag begins, so a single-file drag shows the
  // real macOS file icon rather than the generic fallback.
  row.addEventListener('mouseenter', () => {
    window.api.warmDragIcons([item.path]);
    clearTimeout(tooltipTimer);
    tooltipTimer = setTimeout(() => showTooltipFor(row, item), 450);
  });
  row.addEventListener('mouseleave', hideTooltip);
  // A lingering tooltip during a drag or a menu would be noise.
  row.addEventListener('mousedown', hideTooltip);
  row.addEventListener('dragstart', hideTooltip);
  row.addEventListener('contextmenu', hideTooltip);

  return row;
}

function buildColumn(columnIndex) {
  const column = columns[columnIndex];
  const columnEl = document.createElement('ul');
  columnEl.className = 'column';
  columnEl.dataset.index = String(columnIndex);

  attachDropHandlers(columnEl, columnIndex);

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

// ── Tags, notes, pins ─────────────────────────────────────

const MAX_VISIBLE_TAGS = 3;

const NOTE_SVG =
  '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">' +
  '<path d="M2.5 3h7M2.5 6h7M2.5 9h4"/></svg>';

const PIN_SVG =
  '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">' +
  '<path d="M7.2 1 11 4.8 9.6 6.2 9 5.6 6.9 7.7l-.3 2.2-1.1-1.1-2.4 2.4-.7-.7 2.4-2.4L3.7 7l2.2-.3L8 4.6l-.6-.6z"/></svg>';

// ── Name tooltip ──────────────────────────────────────────
// Only shown when the name is genuinely clipped, so most rows never get one.

let tooltipTimer = null;

function hideTooltip() {
  clearTimeout(tooltipTimer);
  tooltipTimer = null;
  tooltipEl.hidden = true;
}

// The head span carries overflow:hidden and the ellipsis, so comparing its
// scroll width against its client width is the real test of whether anything
// is actually hidden.
function isNameTruncated(row) {
  const head = row.querySelector('.name-head');
  return head ? head.scrollWidth > head.clientWidth + 1 : false;
}

function showTooltipFor(row, item) {
  if (!isNameTruncated(row)) return;

  tooltipEl.textContent = item.tags && item.tags.length > 0
    ? `${item.name}\nTags: ${item.tags.join(', ')}`
    : item.name;
  tooltipEl.hidden = false;

  const panel = document.querySelector('.panel').getBoundingClientRect();
  const box = row.getBoundingClientRect();
  const width = tooltipEl.offsetWidth;
  const height = tooltipEl.offsetHeight;

  let left = box.left - panel.left + 18;
  left = Math.max(6, Math.min(left, panel.width - width - 6));
  // Below the row by default, flipped above when there is no room.
  let top = box.bottom - panel.top + 4;
  if (top + height > panel.height - 6) top = box.top - panel.top - height - 4;

  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top = `${top}px`;
}

function markerButton(className, svg, label, onClick) {
  const button = document.createElement('button');
  button.className = `marker ${className}`;
  button.innerHTML = svg; // static markup, never interpolated
  button.title = label;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', onClick);
  // A marker click must not start a file drag.
  button.addEventListener('dragstart', (event) => event.preventDefault());
  return button;
}

// A tag's colour is derived from its name, so the same tag is always the
// same colour and the user never picks one. Low saturation and a mid
// lightness keep it inside the HUD's register.
// The automatic colour, used until the user picks one explicitly.
function autoTagColor(tag) {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) % 360;
  return { fg: `hsl(${hash} 46% 70%)`, bg: `hsla(${hash}, 46%, 70%, 0.16)` };
}

function withAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// An explicit choice wins; otherwise fall back to the derived colour, so
// nothing changes until the user actually picks something.
function tagColor(tag) {
  const chosen = tagColorMap[tag];
  if (chosen) return { fg: chosen, bg: withAlpha(chosen, 0.16) };
  return autoTagColor(tag);
}

function paintPill(node, tag) {
  const { fg, bg } = tagColor(tag);
  node.style.color = fg;
  node.style.backgroundColor = bg;
}

function buildPill(tag) {
  const pill = document.createElement('span');
  pill.className = 'pill';
  pill.textContent = tag;
  pill.dataset.tag = tag;
  paintPill(pill, tag);

  // Right-clicking a pill picks its colour. stopPropagation is what keeps
  // the row's file context menu from swallowing it; without it the row
  // handler fires and the palette never appears.
  pill.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openColorPopover(tag, pill);
  });

  return pill;
}

// A tag's colour is global, so repaint every pill in place rather than
// rebuilding columns — that keeps scroll position and selection.
function repaintTags() {
  for (const pill of columnsEl.querySelectorAll('.pill:not(.more)')) {
    if (pill.dataset.tag) paintPill(pill, pill.dataset.tag);
  }
}

// Swatch strip. `selected` is the currently active value, or null for
// automatic. onPick receives a hex string, or null to reset.
function buildSwatches(selected, onPick) {
  const strip = document.createElement('div');
  strip.className = 'swatches';

  const auto = document.createElement('button');
  auto.className = `swatch auto${selected ? '' : ' selected'}`;
  auto.textContent = 'A';
  auto.title = 'Automatic (derived from the tag name)';
  auto.setAttribute('aria-label', 'Automatic colour');
  auto.addEventListener('click', () => onPick(null));
  strip.append(auto);

  for (const entry of tagPalette) {
    const swatch = document.createElement('button');
    swatch.className = `swatch${selected === entry.value ? ' selected' : ''}`;
    swatch.style.backgroundColor = entry.value;
    swatch.title = entry.name;
    swatch.setAttribute('aria-label', entry.name);
    swatch.addEventListener('click', () => onPick(entry.value));
    strip.append(swatch);
  }

  return strip;
}

function openColorPopover(tag, anchor) {
  const popover = openPopover(anchor, tag);

  const hint = document.createElement('p');
  hint.className = 'popover-hint';
  hint.textContent = 'Applies to this tag everywhere. Escape closes.';

  popover.append(buildSwatches(tagColorMap[tag] || null, async (color) => {
    // Applied immediately, then closed. Escape before choosing changes
    // nothing.
    await window.api.setTagColor(tag, color);
    closePopover({ save: false });
  }));
  popover.append(hint);
}

// ── Popover ───────────────────────────────────────────────
// One reused element, positioned near the row it belongs to.

let popoverSave = null;

function closePopover({ save = true } = {}) {
  if (popoverEl.hidden) return;
  const pending = popoverSave;
  popoverSave = null;
  popoverEl.hidden = true;
  popoverEl.replaceChildren();
  if (save && pending) pending();
}

function positionPopover(anchor) {
  const panel = document.querySelector('.panel').getBoundingClientRect();
  const box = anchor.getBoundingClientRect();
  const width = 240;
  let left = box.left - panel.left;
  left = Math.max(8, Math.min(left, panel.width - width - 8));
  let top = box.bottom - panel.top + 4;
  // Flip above the row if there is not room below.
  if (top + 160 > panel.height) top = Math.max(8, box.top - panel.top - 164);
  popoverEl.style.left = `${left}px`;
  popoverEl.style.top = `${top}px`;
}

function openPopover(anchor, title) {
  closePopover();
  popoverEl.replaceChildren();
  const heading = document.createElement('p');
  heading.className = 'popover-title';
  heading.textContent = title;
  popoverEl.append(heading);
  popoverEl.hidden = false;
  positionPopover(anchor);
  return popoverEl;
}

function rowElementFor(filePath) {
  return columnsEl.querySelector(`.row[data-path="${CSS.escape(filePath)}"]`);
}

async function openNotePopover(filePath, anchor) {
  const target = anchor || rowElementFor(filePath);
  if (!target) return;

  const note = await window.api.getNote(filePath);
  const popover = openPopover(target, 'Note');

  const field = document.createElement('textarea');
  field.value = note;
  field.placeholder = 'Write a note…';
  popover.append(field);

  const hint = document.createElement('p');
  hint.className = 'popover-hint';
  hint.textContent = 'Saves when you close it. Escape closes.';
  popover.append(hint);

  // Saved on close or blur — no explicit save button.
  popoverSave = () => window.api.setNote(filePath, field.value);
  field.focus();
}

async function openTagPopover(filePath, anchor) {
  const target = anchor || rowElementFor(filePath);
  if (!target) return;

  const popover = openPopover(target, 'Tags');
  const known = await window.api.knownTags();

  const list = document.createElement('div');
  list.className = 'tag-list';
  popover.append(list);

  const item = findItemByPath(filePath);
  const current = item && item.tags ? [...item.tags] : [];

  for (const tag of current) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    const { fg, bg } = tagColor(tag);
    chip.style.color = fg;
    chip.style.backgroundColor = bg;
    chip.append(document.createTextNode(tag));
    const remove = document.createElement('button');
    remove.textContent = '×';
    remove.title = `Remove ${tag}`;
    remove.addEventListener('click', async () => {
      await window.api.removeTag(filePath, tag);
      closePopover({ save: false });
    });
    chip.append(remove);
    list.append(chip);
  }

  const field = document.createElement('input');
  field.type = 'text';
  field.placeholder = 'Add a tag…';
  field.setAttribute('list', 'known-tags');
  popover.append(field);

  // Every tag ever used is offered as a suggestion.
  const datalist = document.createElement('datalist');
  datalist.id = 'known-tags';
  for (const tag of known) {
    const option = document.createElement('option');
    option.value = tag;
    datalist.append(option);
  }
  popover.append(datalist);

  const hint = document.createElement('p');
  hint.className = 'popover-hint';
  hint.textContent = 'Return adds. Escape closes.';
  popover.append(hint);

  // Colour can be chosen at creation rather than as a second step. Null
  // means automatic, which is preselected.
  let pendingColor = null;
  const swatches = buildSwatches(null, (color) => {
    pendingColor = color;
    // Reflect the choice without closing: the tag does not exist yet.
    for (const node of swatches.children) node.classList.remove('selected');
    const index = color === null ? 0 : tagPalette.findIndex((e) => e.value === color) + 1;
    if (swatches.children[index]) swatches.children[index].classList.add('selected');
  });
  popover.append(swatches);

  field.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const value = field.value.trim();
    if (!value) return;
    await window.api.addTag(filePath, value);
    // Only write a colour when one was actually picked, so an untouched
    // palette leaves the tag on automatic.
    if (pendingColor) await window.api.setTagColor(value, pendingColor);
    closePopover({ save: false });
  });

  field.focus();
}

function findItemByPath(filePath) {
  for (const column of columns) {
    const found = column.items.find((entry) => entry.path === filePath);
    if (found) return found;
  }
  return null;
}

// Keys typed inside the popover must never reach the document handler, or
// Escape would close a column and Space would open a preview.
popoverEl.addEventListener('keydown', (event) => {
  event.stopPropagation();
  if (event.key === 'Escape') closePopover(); // saves what was typed
});

// Clicking away closes and saves.
document.addEventListener('mousedown', (event) => {
  if (popoverEl.hidden) return;
  if (!popoverEl.contains(event.target)) closePopover();
});

window.api.onTagColorsChanged((map) => {
  tagColorMap = map;
  repaintTags();
});

window.api.onOpenTagEditor((filePath) => openTagPopover(filePath));
window.api.onOpenNoteEditor((filePath) => openNotePopover(filePath));

// ── Errors ────────────────────────────────────────────────

let toastTimer = null;

// Copy failures must be visible. Permission denied, disk full and a
// vanished source all surface here rather than being swallowed.
function showToast(lines) {
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines);
  if (!text) return;
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 6000);
}

// ── Drop in ───────────────────────────────────────────────
// Incoming drags from other apps. This is ordinary HTML5 drag and drop,
// which is fine for RECEIVING files — the restriction is the other way
// round: HTML5 cannot SEND a file to another macOS app, which is why
// dragging out uses webContents.startDrag instead.
//
// Dragging a row out never reaches these handlers: onRowDragStart calls
// preventDefault, so no HTML5 drag session is created and the native drag
// generates no DOM drag events.

function dragCarriesFiles(event) {
  return Array.from(event.dataTransfer.types || []).includes('Files');
}

// A folder row under the cursor wins over its column, so a drop lands in the
// folder rather than beside it.
function dropTargetFor(columnIndex, node) {
  const row = node && node.closest ? node.closest('.row.is-dir') : null;
  if (row && row.dataset.path) return { dir: row.dataset.path, el: row };
  return { dir: columns[columnIndex].path, el: columnsEl.children[columnIndex] };
}

function clearDropHighlight() {
  for (const el of columnsEl.querySelectorAll('.drop-target')) {
    el.classList.remove('drop-target');
  }
}

function attachDropHandlers(columnEl, columnIndex) {
  // Nested children fire dragleave constantly, so highlight state is driven
  // from dragover, which fires continuously with an accurate target.
  columnEl.addEventListener('dragover', (event) => {
    if (!dragCarriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy'; // always a copy, never a move
    const target = dropTargetFor(columnIndex, event.target);
    if (!target.el || target.el.classList.contains('drop-target')) return;
    clearDropHighlight();
    target.el.classList.add('drop-target');
  });

  columnEl.addEventListener('dragleave', (event) => {
    // Only clear when the cursor has actually left the column.
    if (event.relatedTarget && columnEl.contains(event.relatedTarget)) return;
    clearDropHighlight();
  });

  columnEl.addEventListener('drop', async (event) => {
    if (!dragCarriesFiles(event)) return;
    event.preventDefault();
    clearDropHighlight();

    const target = dropTargetFor(columnIndex, event.target);
    const sources = Array.from(event.dataTransfer.files)
      .map((file) => window.api.getPathForFile(file))
      .filter(Boolean);
    if (sources.length === 0) return;

    const result = await window.api.copyInto(target.dir, sources);
    if (result.errors && result.errors.length > 0) showToast(result.errors);
  });
}

// ── Clipboard ─────────────────────────────────────────────

// The folder a paste lands in: the column holding the selection, falling
// back to the rightmost column.
function activeColumn() {
  const withSelection = columns.find((column) => column.selected.size > 0);
  return withSelection || columns[columns.length - 1] || null;
}

function copySelectionToClipboard() {
  const paths = selectedPathsAcrossColumns();
  if (paths.length === 0) return;
  window.api.copyFilesToClipboard(paths);
}

async function pasteIntoActiveColumn() {
  const column = activeColumn();
  if (!column) return;
  const result = await window.api.pasteInto(column.path);
  if (result.errors && result.errors.length > 0) showToast(result.errors);
}

// ── Move to Trash ─────────────────────────────────────────

async function trashSelection() {
  const paths = selectedPathsAcrossColumns();
  if (paths.length === 0) return; // nothing selected: do nothing

  // No confirmation. Trash is recoverable, and this matches Finder.
  const result = await window.api.trashPaths(paths);

  // The affected column arrives separately as a dir-changed update, which
  // would drop these anyway; clearing here makes it explicit and immediate.
  clearAllSelections();
  syncSelectionClasses();

  if (result.errors && result.errors.length > 0) showToast(result.errors);
}

function selectedPathsAcrossColumns() {
  for (const column of columns) {
    if (column.selected.size > 0) return [...column.selected];
  }
  return [];
}

// ── Live updates ──────────────────────────────────────────

function syncWatchers() {
  window.api.setWatched(columns.map((column) => column.path));
}

// Rebuild one column in place. Selection and scroll position both survive:
// a refresh must not yank the user back to the top or silently deselect a
// file that is still there.
function applyDirChange(payload) {
  const columnIndex = columns.findIndex((column) => column.path === payload.path);
  if (columnIndex === -1) return; // a column that has since closed

  // The folder itself is gone: truncate the trail here rather than leaving
  // a dead column behind.
  if (!payload.result.ok) {
    if (columnIndex === 0) {
      columns = [];
      showMessage(errorText(payload.result.code));
      syncWatchers();
      return;
    }
    columns.length = columnIndex;
    columns[columns.length - 1].openChild = null;
    while (columnsEl.children.length > columns.length) columnsEl.lastElementChild.remove();
    syncSelectionClasses();
    updateCount();
    syncWatchers();
    return;
  }

  const column = columns[columnIndex];
  const columnEl = columnsEl.children[columnIndex];
  const scrollTop = columnEl ? columnEl.scrollTop : 0;

  column.items = payload.result.items;
  if (payload.result.tagColors) tagColorMap = payload.result.tagColors;

  // Keep only selections that still exist; drop the rest silently.
  const present = new Set(column.items.map((item) => item.path));
  for (const selectedPath of [...column.selected]) {
    if (!present.has(selectedPath)) column.selected.delete(selectedPath);
  }
  // The anchor is an index into a list that just changed underneath it.
  column.anchor = null;

  // If the folder that opened the next column has gone, the trail below it
  // is meaningless.
  if (column.openChild && !present.has(column.openChild)) {
    columns.length = columnIndex + 1;
    column.openChild = null;
    while (columnsEl.children.length > columns.length) columnsEl.lastElementChild.remove();
  }

  const rebuilt = buildColumn(columnIndex);
  if (columnEl) columnsEl.replaceChild(rebuilt, columnEl);
  else columnsEl.append(rebuilt);
  rebuilt.scrollTop = scrollTop;

  syncSelectionClasses();
  updateCount();
  syncWatchers();
}

function renderColumns() {
  const fragment = document.createDocumentFragment();
  columns.forEach((_, columnIndex) => fragment.append(buildColumn(columnIndex)));
  columnsEl.replaceChildren(fragment);
  columnsEl.hidden = false;
  messageEl.hidden = true;
  syncSelectionClasses();
  updateCount();
  syncWatchers();
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
  syncWatchers();
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
    if (result.tagColors) tagColorMap = result.tagColors;
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
    syncWatchers();
    return;
  }

  for (let i = 0; i < rebuilt.length - 1; i++) rebuilt[i].openChild = rebuilt[i + 1].path;
  columns = rebuilt;
  renderColumns();
}

// Every shortcut here is a bare key or a plain modifier combo, so any of them
// would hijack typing. There is no text input yet, but tags and notes are
// coming — guarding now rather than retrofitting later. Escape is exempt: it
// should still dismiss things while a field has focus.
function isTypingTarget(node) {
  if (!node) return false;
  if (node.isContentEditable) return true;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    // Resolution order matters: preview first, then step back a column,
    // then clear the selection.
    if (previewOpen) {
      closePreview();
      return;
    }
    if (closeRightmostColumn()) return;
    clearAllSelections();
    syncSelectionClasses();
    return;
  }

  if (isTypingTarget(event.target)) return;

  // Must be tested BEFORE bare Backspace, which closes a column. On macOS the
  // key labelled Delete reports as 'Backspace'; 'Delete' is forward-delete.
  if (event.metaKey && (event.key === 'Backspace' || event.key === 'Delete')) {
    event.preventDefault();
    trashSelection();
    return;
  }

  if (event.key === 'Backspace') {
    event.preventDefault();
    closeRightmostColumn();
    return;
  }

  if (event.metaKey && (event.key === 'c' || event.key === 'C')) {
    event.preventDefault();
    copySelectionToClipboard();
    return;
  }

  if (event.metaKey && (event.key === 'v' || event.key === 'V')) {
    event.preventDefault();
    pasteIntoActiveColumn();
    return;
  }

  if (event.key === ' ') {
    // Otherwise Space scrolls the column.
    event.preventDefault();
    togglePreview();
    return;
  }

  // Arrow keys walk the previewed column only while the overlay is open, so
  // they do not interfere with normal scrolling otherwise.
  if (previewOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault();
    stepPreview(event.key === 'ArrowDown' ? 1 : -1);
  }
});


// The preview window can be closed from its own close button or by the panel
// being hidden. This is a notification only — it changes no visibility here.
window.api.onPreviewClosed(() => {
  previewOpen = false;
  previewColumnIndex = null;
  previewRowIndex = null;
});

// Arrow keys pressed in the preview window: only this side knows the column.
window.api.onPreviewStep(stepPreview);

columnsEl.addEventListener('scroll', hideTooltip, true);
columnsEl.addEventListener('mouseleave', hideTooltip);

// A watched directory changed. Only that column's contents arrive.
window.api.onDirChanged(applyDirChange);

// Failures from operations started in the main process, such as a Paste
// driven from the context menu.
window.api.onOperationError(showToast);

async function init() {
  try {
    tagPalette = await window.api.tagPalette();
    tagColorMap = await window.api.tagColors();
  } catch (err) {
    console.error('[renderer] could not load the tag palette:', err);
  }

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
