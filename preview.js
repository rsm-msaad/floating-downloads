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

function render(info) {
  nameEl.textContent = info.name;
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
