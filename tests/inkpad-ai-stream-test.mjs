// tests/inkpad-ai-stream-test.mjs — the streaming chat path.
//
// WHY: the chat sidebar shows the answer WHILE the model writes it, so the
// SSE reader is the piece that matters: it has to understand the three
// wire shapes (OpenAI, Anthropic, Gemini), fall back to a one-shot answer
// when a provider does not stream, and never hang on a bad response.
//
// Plain Node, no dependencies: the fetch is a stub and the stream is a real
// ReadableStream.

import { callProviderStream, streamDelta, readSseText, AiError } from '../src/ai/client.js';
import { buildRequest, supportsStreaming } from '../src/ai/providers.js';

let checks = 0;
let failures = 0;

function ok(name, condition, detail = '') {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.log(`FAIL: ${name}${detail ? ` (${detail})` : ''}`);
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(name, a === b, `got ${a}, want ${b}`);
}

async function throws(name, fn, code) {
  checks += 1;
  try {
    await fn();
    failures += 1;
    console.log(`FAIL: ${name} (no error thrown)`);
  } catch (err) {
    if (err instanceof AiError && err.code === code) return;
    failures += 1;
    console.log(`FAIL: ${name} (got ${err?.code || err?.name}: ${err?.message})`);
  }
}

// --- a stream of server-sent events ----------------------------------------

function sseResponse(chunks, { status = 200, contentType = 'text/event-stream' } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

function jsonResponse(value, { status = 200, contentType = 'application/json' } = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': contentType } });
}

const PRESET = {
  id: 'test',
  label: 'Test provider',
  kind: 'openai',
  endpoint: 'https://example.test/v1',
  modelsUrl: 'https://example.test/v1/models',
  apiKey: 'secret-key',
  model: 'test-model',
  auth: 'bearer',
  vision: true,
};

// --- which kinds can stream --------------------------------------------------

ok('openai can stream', supportsStreaming('openai'));
ok('gemini-generate can stream', supportsStreaming('gemini-generate'));
ok('anthropic can stream', supportsStreaming('anthropic'));
ok('raw cannot stream', !supportsStreaming('raw'));
ok('gemini-interactions cannot stream', !supportsStreaming('gemini-interactions'));

// --- the request carries the stream flag -------------------------------------

const openaiRequest = buildRequest(PRESET, { messages: [{ role: 'user', content: 'hi' }], stream: true });
ok('the openai request asks for a stream', openaiRequest.body.stream === true);
ok('the openai request keeps the model', openaiRequest.body.model === 'test-model');
ok('the openai request keeps the key in a header', openaiRequest.headers.Authorization === 'Bearer secret-key');

const openaiPlain = buildRequest(PRESET, { messages: [{ role: 'user', content: 'hi' }] });
ok('the openai request is one-shot by default', openaiPlain.body.stream === false);

const geminiPreset = { ...PRESET, kind: 'gemini-generate', endpoint: 'https://g.test/v1beta', auth: 'x-goog-api-key' };
const geminiStream = buildRequest(geminiPreset, { messages: [{ role: 'user', content: 'hi' }], stream: true });
ok('the gemini request uses the streaming endpoint', geminiStream.url.includes(':streamGenerateContent'), geminiStream.url);
ok('the gemini request asks for sse', geminiStream.url.includes('alt=sse'), geminiStream.url);
const geminiPlain = buildRequest(geminiPreset, { messages: [{ role: 'user', content: 'hi' }] });
ok('the gemini one-shot request is unchanged', geminiPlain.url.includes(':generateContent'), geminiPlain.url);

const anthropicPreset = { ...PRESET, kind: 'anthropic', endpoint: 'https://a.test', auth: 'x-api-key' };
const anthropicStream = buildRequest(anthropicPreset, { messages: [{ role: 'user', content: 'hi' }], stream: true });
ok('the anthropic request asks for a stream', anthropicStream.body.stream === true);
ok('the anthropic request keeps the version header', anthropicStream.headers['anthropic-version'] === '2023-06-01');

// --- the delta extractors ----------------------------------------------------

eq('an openai delta', streamDelta('openai', { choices: [{ delta: { content: 'Hel' } }] }), 'Hel');
eq('an openai delta with a full message', streamDelta('openai', { choices: [{ message: { content: 'Hey' } }] }), 'Hey');
eq('an openai event with no text', streamDelta('openai', { choices: [{ delta: {} }] }), '');
eq('an anthropic delta', streamDelta('anthropic', { type: 'content_block_delta', delta: { text: 'lo' } }), 'lo');
eq('an anthropic keep-alive', streamDelta('anthropic', { type: 'ping' }), '');
eq('a gemini delta', streamDelta('gemini-generate', { candidates: [{ content: { parts: [{ text: 'Hi' }] } }] }), 'Hi');
eq('a gemini delta with several parts', streamDelta('gemini-generate', { candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] }), 'ab');
eq('an unknown kind has no delta', streamDelta('raw', { anything: true }), '');

// --- streaming an openai answer ----------------------------------------------

{
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: {"choices":[{"delta":{}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const deltas = [];
  const result = await callProviderStream(
    PRESET,
    { messages: [{ role: 'user', content: 'hi' }] },
    { fetchImpl: async () => sseResponse(chunks), onDelta: (delta, text) => deltas.push([delta, text]) },
  );
  eq('the openai stream reports every fragment', deltas, [['Hel', 'Hel'], ['lo', 'Hello']]);
  eq('the openai stream ends with the whole answer', result.text, 'Hello');
  ok('the openai stream says it streamed', result.streamed === true);
}

// --- streaming an anthropic answer -------------------------------------------

{
  const chunks = [
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"Bon"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"jour"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const deltas = [];
  const result = await callProviderStream(
    { ...PRESET, kind: 'anthropic', endpoint: 'https://a.test', auth: 'x-api-key' },
    { messages: [{ role: 'user', content: 'hi' }] },
    { fetchImpl: async () => sseResponse(chunks), onDelta: (delta) => deltas.push(delta) },
  );
  eq('the anthropic stream reports every fragment', deltas, ['Bon', 'jour']);
  eq('the anthropic stream ends with the whole answer', result.text, 'Bonjour');
}

// --- streaming a gemini answer ------------------------------------------------

{
  const chunks = [
    'data: {"candidates":[{"content":{"parts":[{"text":"Good"}]}}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":" morning"}]}}]}\n\n',
  ];
  const result = await callProviderStream(
    { ...PRESET, kind: 'gemini-generate', endpoint: 'https://g.test/v1beta', auth: 'x-goog-api-key' },
    { messages: [{ role: 'user', content: 'hi' }] },
    { fetchImpl: async () => sseResponse(chunks) },
  );
  eq('the gemini stream ends with the whole answer', result.text, 'Good morning');
}

// --- a provider that does not stream -----------------------------------------

{
  const answer = { choices: [{ message: { content: 'One shot' } }] };
  const deltas = [];
  const result = await callProviderStream(
    PRESET,
    { messages: [{ role: 'user', content: 'hi' }] },
    { fetchImpl: async () => jsonResponse(answer), onDelta: (delta) => deltas.push(delta) },
  );
  eq('the one-shot fallback reports the whole answer once', deltas, ['One shot']);
  eq('the one-shot fallback returns the answer', result.text, 'One shot');
  ok('the one-shot fallback says it did not stream', result.streamed === false);
}

{
  // A 'raw' preset cannot stream at all: the whole answer comes at once.
  const rawPreset = { ...PRESET, kind: 'raw', endpoint: 'https://raw.test/ask', auth: 'bearer' };
  const deltas = [];
  const result = await callProviderStream(
    rawPreset,
    { messages: [{ role: 'user', content: 'hi' }] },
    {
      fetchImpl: async () => jsonResponse({ text: 'Raw answer' }),
      onDelta: (delta) => deltas.push(delta),
    },
  );
  eq('the raw fallback reports the whole answer once', deltas, ['Raw answer']);
  eq('the raw fallback returns the answer', result.text, 'Raw answer');
}

// --- an SSE feed with no content-type ----------------------------------------

{
  const raw = 'data: {"choices":[{"delta":{"content":"sniff"}}]}\n\ndata: [DONE]\n\n';
  const result = await callProviderStream(
    PRESET,
    { messages: [{ role: 'user', content: 'hi' }] },
    { fetchImpl: async () => new Response(raw, { status: 200, headers: { 'content-type': 'text/plain' } }) },
  );
  eq('a feed without a content-type is still read as a stream', result.text, 'sniff');
}

eq('readSseText reads a whole feed', readSseText('data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]\n', 'openai'), 'a');
eq('readSseText ignores junk', readSseText('event: ping\n\ndata: not-json\n\n', 'openai'), '');

// --- failures ------------------------------------------------------------------

await throws(
  'a rejected key is a typed error',
  () => callProviderStream(
    PRESET,
    { messages: [{ role: 'user', content: 'hi' }] },
    { fetchImpl: async () => new Response('{"error":{"message":"bad key"}}', { status: 401 }) },
  ),
  'invalid-key',
);

await throws(
  'an unreadable answer is a parse error',
  () => callProviderStream(
    PRESET,
    { messages: [{ role: 'user', content: 'hi' }] },
    { fetchImpl: async () => new Response('not json at all', { status: 200, headers: { 'content-type': 'application/json' } }) },
  ),
  'parse',
);

await throws(
  'a blocked browser call is a cors error',
  () => callProviderStream(
    PRESET,
    { messages: [{ role: 'user', content: 'hi' }] },
    {
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    },
  ),
  'cors',
);

await throws(
  'an aborted request is an abort, not a failure',
  () => callProviderStream(
    PRESET,
    { messages: [{ role: 'user', content: 'hi' }] },
    {
      signal: AbortSignal.abort(),
      fetchImpl: async (url, options) => {
        if (options.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        return sseResponse([]);
      },
    },
  ),
  'aborted',
);

// --- the key never leaks into an error ----------------------------------------

{
  let message = '';
  try {
    await callProviderStream(
      { ...PRESET, apiKey: 'super-secret' },
      { messages: [{ role: 'user', content: 'hi' }] },
      { fetchImpl: async () => new Response('{"error":{"message":"super-secret is not a key"}}', { status: 400 }) },
    );
  } catch (err) {
    message = err.message || '';
  }
  ok('the key is redacted in an error', !message.includes('super-secret'), message);
}

if (failures > 0) {
  console.log(`${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`ALL ${checks} CHECKS PASSED`);
