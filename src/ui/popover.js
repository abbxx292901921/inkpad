// ui/popover.js — the floating panel primitive.
//
// Notability's colour and stroke panels are floating cards anchored under the
// toolbar. This module owns that behaviour once: create a card, anchor it to a
// button, dismiss it on an outside tap or Escape.
//
// A popover is NOT a modal: the canvas stays live while it is open, so you
// can change a colour and keep drawing.

const NS = 'http://www.w3.org/2000/svg';

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function createPopover({ className = '', label = '' } = {}) {
  const card = el('div', `popover ${className}`.trim());
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', label);
  card.hidden = true;
  document.body.appendChild(card);

  let anchor = null;
  let onDismiss = null;

  function close() {
    if (card.hidden) return;
    card.hidden = true;
    anchor = null;
    const cb = onDismiss;
    onDismiss = null;
    if (cb) cb();
  }

  // Outside tap / pen -> close. Capture phase so we see it before the canvas.
  function onDocPointerDown(e) {
    if (card.hidden) return;
    if (card.contains(e.target)) return;
    if (anchor && anchor.contains(e.target)) return;
    close();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && !card.hidden) {
      e.stopPropagation();
      close();
    }
  }

  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);

  // Place the card under the anchor, clamped to the viewport.
  function place() {
    if (!anchor) return;
    const a = anchor.getBoundingClientRect();
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const margin = 10;
    let left = a.left + a.width / 2 - w / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
    let top = a.bottom + 8;
    // Flip above the anchor if there is no room below.
    if (top + h > window.innerHeight - margin) {
      const above = a.top - h - 8;
      top = above > margin ? above : Math.max(margin, window.innerHeight - h - margin);
    }
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
  }

  return {
    el: card,
    isOpen: () => !card.hidden,
    get anchor() {
      return anchor;
    },
    open(anchorEl, { onDismiss: dismissCb } = {}) {
      anchor = anchorEl;
      onDismiss = dismissCb ?? null;
      card.hidden = false;
      place();
      // Re-place after layout settles (fonts, images, flex sizing).
      requestAnimationFrame(place);
      return card;
    },
    close,
    reposition: place,
  };
}

// A small "colour wheel" button. Real conic gradient, not an icon, because a
// monochrome glyph cannot show what it does.
export function colorWheelButton({ onPick } = {}) {
  const wrap = el('span', 'wheel');
  wrap.setAttribute('role', 'button');
  wrap.setAttribute('tabindex', '0');
  wrap.title = 'Custom colour';
  wrap.setAttribute('aria-label', 'Custom colour');

  const input = el('input', 'wheel-input');
  input.type = 'color';
  input.value = '#1b1b1b';
  input.setAttribute('aria-hidden', 'true');
  wrap.appendChild(input);

  const pick = () => onPick(input.value);
  input.addEventListener('input', pick);
  input.addEventListener('change', pick);
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  return wrap;
}

export { el, NS };
