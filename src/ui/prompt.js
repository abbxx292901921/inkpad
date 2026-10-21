// ui/prompt.js — small modal-ish cards for asking the user something.
//
// Two shapes: a text prompt (rename a note, name a folder) and a list prompt
// (pick a folder). Both are floating cards anchored to a button, and both
// close on Escape or an outside tap.

import { el } from './popover.js';

export function buildTextPrompt({ title, placeholder = '', value = '', onSubmit, onCancel } = {}) {
  const root = el('div', 'prompt');
  root.appendChild(el('div', 'prompt-title', title));

  const input = el('input', 'prompt-input');
  input.type = 'text';
  input.placeholder = placeholder;
  input.value = value;
  input.setAttribute('aria-label', title);
  root.appendChild(input);

  const row = el('div', 'prompt-row');
  const cancel = el('button', 'prompt-btn', 'Cancel');
  cancel.type = 'button';
  const ok = el('button', 'prompt-btn prompt-btn-primary', 'OK');
  ok.type = 'button';
  row.appendChild(cancel);
  row.appendChild(ok);
  root.appendChild(row);

  function submit() {
    const text = input.value.trim();
    if (text && onSubmit) onSubmit(text);
  }

  ok.addEventListener('click', submit);
  cancel.addEventListener('click', () => onCancel && onCancel());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (onCancel) onCancel();
    }
  });

  return {
    el: root,
    focus() {
      input.focus();
      input.select();
    },
  };
}

export function buildListPrompt({ title, items = [], onSelect, onCancel, emptyText = 'Nothing here yet.' } = {}) {
  const root = el('div', 'prompt');
  root.appendChild(el('div', 'prompt-title', title));

  const list = el('div', 'prompt-list');
  if (items.length === 0) {
    list.appendChild(el('div', 'prompt-empty', emptyText));
  }
  for (const item of items) {
    const b = el('button', 'prompt-item');
    b.type = 'button';
    if (item.color) {
      const dot = el('span', 'prompt-dot');
      dot.style.background = item.color;
      b.appendChild(dot);
    }
    b.appendChild(el('span', 'prompt-item-label', item.label));
    b.addEventListener('click', () => onSelect && onSelect(item));
    list.appendChild(b);
  }
  root.appendChild(list);

  const row = el('div', 'prompt-row');
  const cancel = el('button', 'prompt-btn', 'Close');
  cancel.type = 'button';
  cancel.addEventListener('click', () => onCancel && onCancel());
  row.appendChild(cancel);
  root.appendChild(row);

  return { el: root };
}
