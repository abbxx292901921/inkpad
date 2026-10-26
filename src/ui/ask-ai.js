// ui/ask-ai.js — the AI chat sidebar.
//
// WHY A SIDEBAR: the old "Ask AI" card was a popover, so it covered the
// page, the popup had to be closed to get on with the drawing, and the
// answer only appeared AFTER the whole reply had arrived. This is a
// docked panel instead: it sits on the right edge, the canvas shrinks
// beside it (the app keeps working while a reply streams in), and the
// text appears word by word.
//
// The panel is a RENDERER. It owns no provider and makes no network
// calls: the app drives it through addUser(), addAssistant() and
// setState(), and the app owns the conversation.
//
// The styles ship in their own file and are linked in at runtime: there is
// no build step, so a CSS import would not work.

import { el } from './popover.js';
import { icon } from './icons.js';

function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('ask-ai-css')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./ask-ai.css', import.meta.url).href;
  link.id = 'ask-ai-css';
  document.head.appendChild(link);
}

// The composer grows with what is typed, up to a limit, then scrolls.
const COMPOSER_MAX = 132;
const COMPOSER_MIN = 44;

export function buildChatPanel({ onSend, onStop, onClose, onOpenSettings } = {}) {
  injectStyles();
  const root = el('aside', 'chat');
  root.hidden = true;
  root.setAttribute('aria-label', 'AI chat');

  // --- header ---------------------------------------------------------------
  const head = el('div', 'chat-head');

  const titleWrap = el('div', 'chat-title-wrap');
  titleWrap.appendChild(el('span', 'chat-title', 'AI'));
  const providerBtn = el('button', 'chat-provider', 'No provider');
  providerBtn.type = 'button';
  providerBtn.title = 'Choose a provider';
  providerBtn.addEventListener('click', () => onOpenSettings && onOpenSettings());
  titleWrap.appendChild(providerBtn);
  head.appendChild(titleWrap);

  const newBtn = el('button', 'chat-icon-btn');
  newBtn.type = 'button';
  newBtn.title = 'New chat';
  newBtn.setAttribute('aria-label', 'New chat');
  newBtn.appendChild(icon('add', { size: 16 }));
  newBtn.addEventListener('click', () => clearChat());
  head.appendChild(newBtn);

  const closeBtn = el('button', 'chat-icon-btn');
  closeBtn.type = 'button';
  closeBtn.title = 'Close the chat';
  closeBtn.setAttribute('aria-label', 'Close the chat');
  closeBtn.appendChild(icon('close', { size: 16 }));
  closeBtn.addEventListener('click', () => onClose && onClose());
  head.appendChild(closeBtn);

  root.appendChild(head);

  // --- the log --------------------------------------------------------------
  const log = el('div', 'chat-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  root.appendChild(log);

  // --- no provider ----------------------------------------------------------
  const empty = el('div', 'chat-empty');
  empty.appendChild(el('p', 'chat-empty-text', 'No AI provider is set up yet. Add one to chat about your notes.'));
  const addProvider = el('button', 'chat-btn chat-btn-primary', 'Add a provider');
  addProvider.type = 'button';
  addProvider.addEventListener('click', () => onOpenSettings && onOpenSettings());
  empty.appendChild(addProvider);
  log.appendChild(empty);

  // --- composer -------------------------------------------------------------
  const composer = el('div', 'chat-composer');

  const hint = el('div', 'chat-hint');
  composer.appendChild(hint);

  const inputWrap = el('div', 'chat-input-wrap');
  const input = el('textarea', 'chat-input');
  input.id = 'chat-input';
  input.rows = 1;
  input.placeholder = 'Ask about this page…';
  inputWrap.appendChild(input);
  composer.appendChild(inputWrap);

  const row = el('div', 'chat-row');

  const annotateBtn = el('button', 'chat-btn', 'Annotate');
  annotateBtn.type = 'button';
  annotateBtn.title = 'Ask the AI to mark up this page';
  annotateBtn.addEventListener('click', () => submit(true));
  row.appendChild(annotateBtn);

  const pageBtn = el('button', 'chat-btn chat-btn-toggle is-on', 'Page');
  pageBtn.type = 'button';
  pageBtn.title = 'Send a picture of the current page with your question';
  pageBtn.addEventListener('click', () => {
    pageBtn.classList.toggle('is-on');
    syncHint();
  });
  row.appendChild(pageBtn);

  const sendBtn = el('button', 'chat-send');
  sendBtn.type = 'button';
  sendBtn.title = 'Send';
  sendBtn.setAttribute('aria-label', 'Send');
  const sendIcon = icon('send', { size: 18 });
  sendBtn.appendChild(sendIcon);
  sendBtn.addEventListener('click', () => {
    if (busy) stop();
    else submit(false);
  });
  row.appendChild(sendBtn);

  composer.appendChild(row);

  const error = el('div', 'chat-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  composer.appendChild(error);

  root.appendChild(composer);

  // --- state ----------------------------------------------------------------
  let busy = false;
  let ready = false;
  let attachPage = true;
  let canSendImage = false;
  let providerLabel = 'No provider';
  let counter = 0;
  let onClear = null;
  const messages = [];

  function stop() {
    if (onStop) onStop();
  }

  function submit(annotate) {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    sizeInput();
    if (onSend) onSend(text, { annotate, attachPage: annotate ? true : attachPage });
  }

  function sizeInput() {
    input.style.height = 'auto';
    const height = Math.min(COMPOSER_MAX, Math.max(COMPOSER_MIN, input.scrollHeight || COMPOSER_MIN));
    input.style.height = `${height}px`;
  }

  function syncHint() {
    if (!ready) {
      hint.textContent = '';
      return;
    }
    if (!canSendImage) {
      hint.textContent = 'This provider cannot read images, so only your question is sent.';
      return;
    }
    hint.textContent = attachPage
      ? 'A picture of the current page is sent with your question.'
      : 'Your question only — the page image is off.';
  }

  function scrollToEnd() {
    log.scrollTop = log.scrollHeight;
  }

  function bubble(role, text, kind) {
    const row = el('div', `chat-msg is-${role}${kind ? ` is-${kind}` : ''}`);
    const body = el('div', 'chat-bubble');
    body.textContent = text || '';
    row.appendChild(body);
    return { row, body };
  }

  function addUser(text) {
    empty.hidden = true;
    const node = bubble('user', text);
    log.appendChild(node.row);
    messages.push({ role: 'user', content: text });
    scrollToEnd();
    return { id: `m${++counter}`, node };
  }

  // An assistant turn starts empty and is filled as the answer streams in.
  function addAssistant() {
    empty.hidden = true;
    const node = bubble('ai', '');
    const caret = el('span', 'chat-caret');
    node.body.appendChild(caret);
    log.appendChild(node.row);
    const entry = { id: `m${++counter}`, node, caret, text: '' };
    messages.push(entry);
    scrollToEnd();
    return entry;
  }

  function updateAssistant(entry, text, { streaming = false } = {}) {
    if (!entry) return;
    entry.text = text ?? '';
    entry.node.body.textContent = entry.text;
    if (entry.caret) entry.node.body.appendChild(entry.caret);
    entry.node.row.classList.toggle('is-streaming', streaming);
    scrollToEnd();
  }

  function failAssistant(entry, message) {
    if (!entry) return;
    entry.node.row.classList.remove('is-streaming');
    entry.node.row.classList.add('is-error');
    entry.node.body.textContent = message;
    if (entry.caret) entry.node.body.appendChild(entry.caret);
    scrollToEnd();
  }

  // A short notice in the log: "Added 3 annotations", "Stopped", and so on.
  function addNotice(text, kind = 'info') {
    empty.hidden = true;
    const node = el('div', `chat-notice is-${kind}`, text);
    log.appendChild(node);
    scrollToEnd();
    return node;
  }

  function clearChat() {
    for (const message of messages) {
      if (message.node?.row) message.node.row.remove();
    }
    messages.length = 0;
    log.textContent = '';
    log.appendChild(empty);
    empty.hidden = ready;
    if (onClear) onClear();
  }

  function setBusy(value) {
    busy = Boolean(value);
    sendBtn.classList.toggle('is-stop', busy);
    sendBtn.title = busy ? 'Stop' : 'Send';
    sendBtn.setAttribute('aria-label', busy ? 'Stop' : 'Send');
    sendBtn.textContent = '';
    sendBtn.appendChild(busy ? icon('stop', { size: 16 }) : icon('send', { size: 18 }));
    annotateBtn.disabled = busy;
  }

  input.addEventListener('input', sizeInput);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      // Enter sends on a keyboard; on a touch keyboard Enter is a newline,
      // so the Send button is the way there.
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        submit(false);
      }
    }
  });

  return {
    element: root,
    onClear(handler) {
      onClear = handler;
    },
    open() {
      root.hidden = false;
      scrollToEnd();
    },
    close() {
      root.hidden = true;
    },
    toggle() {
      if (root.hidden) this.open();
      else this.close();
      return !root.hidden;
    },
    isOpen: () => !root.hidden,
    focus() {
      input.focus();
    },
    clearChat,
    addUser,
    addAssistant,
    updateAssistant,
    failAssistant,
    addNotice,
    setBusy,
    setState(state = {}) {
      if (state.ready !== undefined) ready = Boolean(state.ready);
      if (state.providerLabel !== undefined) providerLabel = state.providerLabel || 'No provider';
      if (state.canSendImage !== undefined) canSendImage = Boolean(state.canSendImage);
      if (state.attachPage !== undefined) attachPage = Boolean(state.attachPage);
      providerBtn.textContent = providerLabel;
      empty.hidden = ready;
      composer.hidden = !ready;
      pageBtn.classList.toggle('is-on', attachPage);
      syncHint();
    },
    setError(message) {
      error.textContent = message || '';
      error.hidden = !message;
    },
    messages,
  };
}
