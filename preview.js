'use strict';

// Renderer for the floating preview window. It renders whatever the main
// process hands it and forwards intent back — it holds no column or
// selection state, and it never changes any window's visibility.

const nameEl = document.getElementById('name');
const metaEl = document.getElementById('meta');
const bodyEl = document.getElementById('body');
const closeEl = document.getElementById('close');

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatDate(ms) {
  return new Date(ms).toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}

function element(tag, className, props) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  Object.assign(node, props || {});
  return node;
}

// The folder currently on screen, so a size that arrives later is only
// applied if it belongs to this card.
let currentFolderPath = null;

const FOLDER_SVG =
  '<svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">' +
  '<path d="M1 3.2c0-.66.54-1.2 1.2-1.2h3l1.4 1.4h5.2c.66 0 1.2.54 1.2 1.2v6c0 .66-.54 1.2-1.2 1.2H2.2c-.66 0-1.2-.54-1.2-1.2V3.2z"/>' +
  '</svg>';

const FILE_SVG =
  '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">' +
  '<path d="M3.5 1.6h4.4l2.6 2.6v8.2H3.5z" stroke-linejoin="round"/>' +
  '<path d="M7.9 1.6v2.6h2.6" stroke-linejoin="round"/>' +
  '</svg>';

function renderFolder(info) {
  currentFolderPath = info.path;

  const card = element('div', 'folder-card');

  const stats = element('dl', 'folder-stats');
  const rows = [
    ['Items', String(info.itemCount)],
    // Placeholder until the recursive walk resolves.
    ['Size', 'Calculating…'],
    ['Modified', formatDate(info.modified)]
  ];
  for (const [label, value] of rows) {
    stats.append(element('dt', null, { textContent: label }));
    const dd = element('dd', null, { textContent: value });
    if (label === 'Size') dd.id = 'folder-size';
    stats.append(dd);
  }
  card.append(stats);

  if (info.entries.length > 0) {
    card.append(element('p', 'folder-heading', {
      textContent: info.itemCount > info.shownCount
        ? `First ${info.shownCount} of ${info.itemCount}`
        : 'Contents'
    }));

    const list = element('ul', 'folder-list');
    for (const entry of info.entries) {
      const li = element('li', 'folder-entry');
      const icon = element('span', 'folder-entry-icon');
      icon.innerHTML = entry.isDirectory ? FOLDER_SVG : FILE_SVG; // static markup
      // textContent, never innerHTML: these are untrusted filenames.
      li.append(icon, element('span', 'folder-entry-name', { textContent: entry.name }));
      list.append(li);
    }
    card.append(list);
  } else {
    card.append(element('p', 'folder-heading', { textContent: 'Empty folder' }));
  }

  bodyEl.className = 'body kind-folder';
  bodyEl.replaceChildren(card);
}

// Arrives after the card is already on screen.
window.api.onPreviewSize(({ path: folderPath, bytes, approximate }) => {
  if (folderPath !== currentFolderPath) return;
  const target = document.getElementById('folder-size');
  if (target) target.textContent = `${approximate ? 'over ' : ''}${formatSize(bytes)}`;
});

function render(info) {
  nameEl.textContent = info.name;

  if (info.kind === 'folder') {
    metaEl.textContent = `${info.itemCount} item${info.itemCount === 1 ? '' : 's'}`;
    renderFolder(info);
    return;
  }

  currentFolderPath = null;
  metaEl.textContent = formatSize(info.size);

  bodyEl.className = 'body';
  bodyEl.replaceChildren();

  if (info.kind === 'image') {
    // alt is the filename, so a broken image still says which file it was.
    bodyEl.append(element('img', 'preview-image', { src: info.url, alt: info.name }));
    return;
  }

  if (info.kind === 'pdf') {
    const embed = element('embed', 'preview-frame');
    embed.type = 'application/pdf';
    embed.src = info.url;
    bodyEl.append(embed);
    return;
  }

  if (info.kind === 'video' || info.kind === 'audio') {
    const media = element(info.kind, 'preview-media', { src: info.url, controls: true });
    if (info.kind === 'audio') media.dataset.audio = '';
    bodyEl.append(media);
    return;
  }

  if (info.kind === 'text') {
    bodyEl.className = 'body kind-text';
    // textContent, never innerHTML: this is untrusted file content.
    bodyEl.append(element('pre', 'preview-text', { textContent: info.text }));
    if (info.truncated) {
      bodyEl.append(element('p', 'preview-truncated', {
        textContent: `Showing the first 100 KB of ${formatSize(info.size)}.`
      }));
    }
    return;
  }

  const fallback = element('div', 'preview-fallback');
  if (info.iconDataUrl) fallback.append(element('img', null, { src: info.iconDataUrl, alt: '' }));
  fallback.append(element('p', 'fallback-name', { textContent: info.name }));
  fallback.append(element('p', 'fallback-meta', {
    textContent: `${info.ext ? `${info.ext.toUpperCase()} file` : 'File'}\n${formatSize(info.size)}\n${formatDate(info.modified)}`
  }));
  const open = element('button', 'preview-open-btn', { textContent: 'Open in default app' });
  open.addEventListener('click', () => window.api.openFile(info.path));
  fallback.append(open);
  bodyEl.append(fallback);
}

// Detaching the media element is what actually stops playback; hiding the
// window alone would leave a video audible.
function clearBody() {
  bodyEl.replaceChildren();
}

function requestClose() {
  clearBody();
  window.api.closePreview();
}

window.api.onPreviewData(render);

closeEl.addEventListener('click', requestClose);

// The window is shown with showInactive(), so it is usually unfocused and
// these never fire — the panel handles the same keys. They matter once the
// user clicks into this window.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' || event.key === ' ') {
    event.preventDefault();
    requestClose();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    // The panel owns the column state, so stepping is resolved there.
    window.api.stepPreview(event.key === 'ArrowDown' ? 1 : -1);
  }
});
