// ui/ask-ai.js — the "Ask AI" panel.
//
// A floating card with a prompt box, the answer, and the state of the
// provider. The panel makes NO network calls: it calls onSubmit and renders
// whatever comes back in update().

import { el } from './popover.js';
import { icon } from './icons.js';

// The styles ship in their own file and are linked in at runtime: there is no
// build step, so a CSS import would not work.
function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('ask-ai-css')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./ask-ai.css', import.meta.url).href;
  link.id = 'ask-ai-css';
  document.head.appendChild(link);
}

export function buildAskAi({ onSubmit, onClose, onOpenSettings } = {}) {
  injectStyles();
  const root = el('div', 'ai');

  const head = el('div', 'ai-head');
  const titleWrap = el('div', 'ai-title-wrap');
  titleWrap.appendChild(el('div', 'ai-title', 'Ask AI'));
  const providerLabel = el('div', 'ai-provider', 'No provider');
  titleWrap.appendChild(providerLabel);
  head.appendChild(titleWrap);

  const closeBtn = el('button', 'ai-icon-btn');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.appendChild(icon('close', { size: 16 }));
  closeBtn.addEventListener('click', () => onClose && onClose());
  head.appendChild(closeBtn);
  root.appendChild(head);

  const body = el('div', 'ai-body');

  // --- no provider configured ---
  const noProvider = el('div', 'ai-empty');
  noProvider.appendChild(el('p', 'ai-empty-text', 'No AI provider is set up yet. Add one to ask questions about your notes.'));
  const addProvider = el('button', 'ai-btn ai-btn-primary', 'Add a provider');
  addProvider.type = 'button';
  addProvider.addEventListener('click', () => onOpenSettings && onOpenSettings());
  noProvider.appendChild(addProvider);
  body.appendChild(noProvider);

  // --- the form ---
  const form = el('div', 'ai-form');

  const promptLabel = el('label', 'ai-label', 'Ask about this page');
  promptLabel.htmlFor = 'ai-prompt';
  const prompt = el('textarea', 'ai-prompt');
  prompt.id = 'ai-prompt';
  prompt.rows = 3;
  prompt.placeholder = 'Solve this, or explain what I wrote here…';
  form.appendChild(promptLabel);
  form.appendChild(prompt);

  const hint = el('div', 'ai-hint');
  form.appendChild(hint);

  const row = el('div', 'ai-row');
  const sendBtn = el('button', 'ai-btn ai-btn-primary', 'Send');
  sendBtn.type = 'button';
  sendBtn.addEventListener('click', () => submit(false));
  row.appendChild(sendBtn);

  const annotateBtn = el('button', 'ai-btn', 'Annotate');
  annotateBtn.type = 'button';
  annotateBtn.addEventListener('click', () => submit(true));
  row.appendChild(annotateBtn);

  const cancelBtn = el('button', 'ai-btn', 'Close');
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('click', () => onClose && onClose());
  row.appendChild(cancelBtn);
  form.appendChild(row);

  const error = el('div', 'ai-error');
  error.setAttribute('role', 'alert');
  form.appendChild(error);

  const confirm = el('div', 'ai-hint');
  confirm.setAttribute('role', 'status');
  form.appendChild(confirm);

  const answerWrap = el('div', 'ai-answer-wrap');
  const answerLabel = el('div', 'ai-label', 'Answer');
  const answer = el('div', 'ai-answer');
  answerWrap.appendChild(answerLabel);
  answerWrap.appendChild(answer);
  form.appendChild(answerWrap);

  body.appendChild(form);
  root.appendChild(body);

  function submit(annotate) {
    const text = prompt.value.trim();
    if (!text) return;
    if (onSubmit) onSubmit(text, annotate ? { annotate: true } : undefined);
  }

  prompt.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit(false);
    }
  });

  return {
    el: root,
    focus() {
      prompt.focus();
    },
    setPrompt(text) {
      prompt.value = text || '';
    },
    update(state) {
      const ready = !!state.ready;
      noProvider.hidden = ready;
      form.hidden = !ready;
      providerLabel.textContent = state.providerLabel || 'No provider';
      hint.textContent = state.hasSelection
        ? 'Your selection will be sent as an image, so the AI can read your handwriting.'
        : 'The current page will be sent as an image.';
      if (!state.canSendImage) {
        hint.textContent = state.hasSelection
          ? 'This provider cannot read images, so only your question will be sent.'
          : 'This provider cannot read images, so only your question will be sent.';
      }
      sendBtn.disabled = !!state.busy;
      sendBtn.textContent = state.busy ? 'Thinking…' : 'Send';
      annotateBtn.disabled = !!state.busy;
      const added = Number.isFinite(state.annotating) ? state.annotating : 0;
      confirm.textContent = added > 0 ? `Added ${added} annotations — undo removes them.` : '';
      confirm.hidden = added <= 0;
      error.textContent = state.error || '';
      error.hidden = !state.error;
      answer.textContent = state.answer || '';
      answerWrap.hidden = !state.answer;
      answerLabel.hidden = !state.answer;
    },
  };
}
