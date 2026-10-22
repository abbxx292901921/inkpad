// inkpad-ai-test.mjs — tests for src/ai/{providers,client,models}.js.
//
// WHY: the AI layer is the one part of Inkpad that talks to a machine we do
// not control, so the wire format is pinned down here: the URL, the headers,
// the body shape and where the answer is read from. A provider that changes
// its shape is a bug we want to see in a test, not in a user's face.
//
// Node has no DOM and no fetch, so the modules must import cleanly without
// either. fetch is injected everywhere it is used, so every test drives a
// stub and no request ever leaves the machine.
//
//   node tests/inkpad-ai-test.mjs

import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const AI = join(SRC, 'ai');

const providers = await import(pathToFileURL(join(AI, 'providers.js')).href);
const client = await import(pathToFileURL(join(AI, 'client.js')).href);
const models = await import(pathToFileURL(join(AI, 'models.js')).href);

const { PROVIDER_KINDS, describeKind, buildRequest, parseResponse, substituteTemplate } = providers;
const { AiError, classifyStatus, callProvider, describeError } = client;
const { fetchModels } = models;

let checks = 0;
let failures = 0;

function ok(cond, label) {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

function eq(actual, expected, label) {
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
  );
}

function throwsWithCode(fn, code, label) {
  try {
    fn();
    ok(false, `${label} (did not throw)`);
  } catch (err) {
    ok(err && err.code === code, `${label} (code ${err && err.code})`);
  }
}

async function rejectsWithCode(fn, code, label) {
  try {
    await fn();
    ok(false, `${label} (did not reject)`);
  } catch (err) {
    ok(err && err.code === code, `${label} (code ${err && err.code})`);
  }
}

// --- fixtures ---------------------------------------------------------------

const KEY = 'sk-test-1234567890';

const IMAGE = {
  dataUrl: 'data:image/png;base64,AAABBBB',
  mimeType: 'image/png',
};

const PAYLOAD = {
  messages: [
    { role: 'user', content: 'Summarise this page.' },
    { role: 'assistant', content: 'Sure.' },
    { role: 'user', content: 'In three bullets.' },
  ],
  system: 'You are a note taker.',
};

function preset(over = {}) {
  return {
    id: 'p1',
    label: 'Test provider',
    kind: 'openai',
    endpoint: 'https://api.openai.com/v1',
    modelsUrl: 'https://api.openai.com/v1/models',
    apiKey: KEY,
    model: 'gpt-4o-mini',
    auth: undefined,
    extraHeaders: undefined,
    vision: true,
    requestTemplate: undefined,
    responseTextPath: undefined,
    ...over,
  };
}

const OPENAI = preset();
const GEMINI = preset({
  kind: 'gemini-generate',
  label: 'Gemini',
  endpoint: 'https://generativelanguage.googleapis.com/v1beta',
  modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
  model: 'gemini-2.0-flash',
});
const INTERACTIONS = preset({ ...GEMINI, kind: 'gemini-interactions' });
const ANTHROPIC = preset({
  kind: 'anthropic',
  label: 'Anthropic',
  endpoint: 'https://api.anthropic.com',
  modelsUrl: 'https://api.anthropic.com/v1/models',
  model: 'claude-sonnet-4',
});
const RAW = preset({
  kind: 'raw',
  label: 'My server',
  endpoint: 'https://example.test/v1/ask',
  requestTemplate: '{"model": {{model}}, "system": {{system}}, "prompt": {{prompt}}, "image": {{image}}}',
});

// --- stubs ------------------------------------------------------------------

function makeResponse({ status = 200, body = null, text = null } = {}) {
  const payload = text !== null ? text : (body === null ? '' : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => payload,
    json: async () => JSON.parse(payload || 'null'),
  };
}

function makeFetch(responder) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url, options });
    return responder(url, options);
  };
  fn.calls = calls;
  return fn;
}

// --- part 1: the kind table ------------------------------------------------

console.log('part 1 — the provider kinds');

eq(
  PROVIDER_KINDS,
  ['openai', 'gemini-generate', 'gemini-interactions', 'anthropic', 'raw'],
  'PROVIDER_KINDS lists the five kinds',
);

const openaiInfo = describeKind('openai');
eq(openaiInfo.kind, 'openai', 'describeKind reports the kind');
eq(openaiInfo.label, 'OpenAI-compatible', 'describeKind reports the label');
eq(openaiInfo.defaultEndpoint, 'https://api.openai.com/v1', 'describeKind reports the default endpoint');
eq(openaiInfo.defaultModelsUrl, 'https://api.openai.com/v1/models', 'describeKind reports the default models URL');
eq(openaiInfo.authStyle, 'bearer', 'describeKind reports the default auth style');
eq(openaiInfo.supportsVision, true, 'describeKind reports vision support');
ok(typeof openaiInfo.help === 'string' && openaiInfo.help.length > 0, 'describeKind explains the kind');

eq(describeKind('gemini-generate').authStyle, 'x-goog-api-key', 'Gemini uses a header key');
eq(describeKind('gemini-interactions').authStyle, 'x-goog-api-key', 'the interactions kind uses a header key');
eq(describeKind('anthropic').authStyle, 'x-api-key', 'Anthropic uses a header key');
eq(describeKind('raw').defaultEndpoint, '', 'the raw kind has no default endpoint');
throwsWithCode(() => describeKind('nope'), undefined, 'describeKind throws for an unknown kind');

describeKind('openai').label = 'mutated';
eq(describeKind('openai').label, 'OpenAI-compatible', 'describeKind hands out a copy, not the table');

// --- part 2: request building ----------------------------------------------

console.log('part 2 — request building');

const openaiReq = buildRequest(OPENAI, PAYLOAD);
eq(openaiReq.url, 'https://api.openai.com/v1/chat/completions', 'openai builds the chat/completions URL');
eq(openaiReq.method, 'POST', 'openai POSTs');
eq(openaiReq.headers.Authorization, `Bearer ${KEY}`, 'openai sends the key as a bearer token');
eq(openaiReq.headers['Content-Type'], 'application/json', 'openai sends JSON');
eq(openaiReq.body.model, 'gpt-4o-mini', 'openai sends the model');
eq(openaiReq.body.stream, false, 'openai does not stream');
eq(openaiReq.body.messages[0], { role: 'system', content: 'You are a note taker.' }, 'openai puts the system text first');
eq(openaiReq.body.messages[1], { role: 'user', content: 'Summarise this page.' }, 'openai keeps the user message');
eq(openaiReq.body.messages[2], { role: 'assistant', content: 'Sure.' }, 'openai keeps the assistant message');

const withExtra = buildRequest(preset({ extraHeaders: { 'X-Trace': 'abc' } }), PAYLOAD);
eq(withExtra.headers['X-Trace'], 'abc', 'extraHeaders are merged into the headers');

const geminiReq = buildRequest(GEMINI, PAYLOAD);
eq(
  geminiReq.url,
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
  'gemini names the model in the path',
);
eq(geminiReq.headers['x-goog-api-key'], KEY, 'gemini sends the key in x-goog-api-key');
eq(geminiReq.body.contents.length, 3, 'gemini turns every message into content');
eq(geminiReq.body.contents[0].role, 'user', 'gemini maps a user message');
eq(geminiReq.body.contents[0].parts[0].text, 'Summarise this page.', 'gemini puts the text in a part');
eq(geminiReq.body.contents[1].role, 'model', 'gemini maps an assistant message to model');
eq(geminiReq.body.systemInstruction.parts[0].text, 'You are a note taker.', 'gemini carries the system text');
eq(geminiReq.body.model, undefined, 'gemini keeps the model out of the body');

eq(
  buildRequest(preset({ kind: 'gemini-generate', model: 'gemini-2.0-flash', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models' }), PAYLOAD).url,
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
  'a gemini endpoint that already ends in /models gets the model appended',
);
eq(
  buildRequest(preset({ kind: 'gemini-generate', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash' }), PAYLOAD).url,
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
  'a gemini endpoint that already names the model is used as it is',
);
eq(
  buildRequest(preset({ kind: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions' }), PAYLOAD).url,
  'https://api.openai.com/v1/chat/completions',
  'an endpoint that is already the full path is not doubled up',
);

const interReq = buildRequest(INTERACTIONS, PAYLOAD);
eq(
  interReq.url,
  'https://generativelanguage.googleapis.com/v1beta/interactions',
  'the interactions kind uses its own path',
);
eq(interReq.body.contents[0].parts[0].text, 'Summarise this page.', 'the interactions kind carries the contents shape');
eq(interReq.body.model, 'gemini-2.0-flash', 'the interactions kind carries the model in the body');

const anthropicReq = buildRequest(ANTHROPIC, PAYLOAD);
eq(anthropicReq.url, 'https://api.anthropic.com/v1/messages', 'anthropic builds the v1/messages URL');
eq(anthropicReq.headers['x-api-key'], KEY, 'anthropic sends the key in x-api-key');
eq(anthropicReq.headers['anthropic-version'], '2023-06-01', 'anthropic sends the version header');
eq(anthropicReq.body.model, 'claude-sonnet-4', 'anthropic sends the model');
eq(anthropicReq.body.max_tokens, 2048, 'anthropic sends a max_tokens');
eq(anthropicReq.body.system, 'You are a note taker.', 'anthropic carries the system text');
eq(anthropicReq.body.messages[0].role, 'user', 'anthropic maps a user message');
eq(anthropicReq.body.messages[0].content[0], { type: 'text', text: 'Summarise this page.' }, 'anthropic uses a text block');

const rawReq = buildRequest(RAW, PAYLOAD);
eq(rawReq.url, 'https://example.test/v1/ask', 'the raw kind uses the endpoint verbatim');
eq(typeof rawReq.body, 'string', 'the raw body is a string');
const rawJson = JSON.parse(rawReq.body);
eq(rawJson.model, 'gpt-4o-mini', 'the raw template substituted the model');
eq(rawJson.system, 'You are a note taker.', 'the raw template substituted the system text');
eq(rawJson.prompt, 'In three bullets.', 'the raw template substituted the last user message');

console.log('part 3 — images');

const openaiImg = buildRequest(OPENAI, { ...PAYLOAD, image: IMAGE });
const openaiParts = openaiImg.body.messages[openaiImg.body.messages.length - 1].content;
eq(Array.isArray(openaiParts), true, 'the openai content becomes an array of parts');
eq(openaiParts[0], { type: 'text', text: 'In three bullets.' }, 'the openai text part comes first');
eq(openaiParts[1], { type: 'image_url', image_url: { url: IMAGE.dataUrl } }, 'the openai image is an image_url part');

const anthropicImg = buildRequest(ANTHROPIC, { ...PAYLOAD, image: IMAGE });
const anthropicBlocks = anthropicImg.body.messages[anthropicImg.body.messages.length - 1].content;
eq(
  anthropicBlocks[1],
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAABBBB' } },
  'the anthropic image is a base64 source',
);

const geminiImg = buildRequest(GEMINI, { ...PAYLOAD, image: IMAGE });
const geminiParts = geminiImg.body.contents[geminiImg.body.contents.length - 1].parts;
eq(geminiParts[1], { inlineData: { mimeType: 'image/png', data: 'AAABBBB' } }, 'the gemini image is inlineData');

console.log('part 4 — the raw template');

eq(
  substituteTemplate('{{model}}|{{system}}|{{prompt}}|{{image}}', {
    model: 'm',
    system: 's',
    prompt: 'p',
    image: 'i',
  }),
  '"m"|"s"|"p"|"i"',
  'substituteTemplate JSON-stringifies every placeholder',
);
eq(
  substituteTemplate('{"q": {{prompt}}}', { prompt: 'he said "hi"' }),
  '{"q": "he said \\"hi\\""}',
  'substituteTemplate escapes the text so the result is valid JSON',
);
eq(substituteTemplate('{{prompt}}', {}), 'null', 'a missing placeholder becomes null');

console.log('part 5 — response parsing');

const openaiJson = {
  model: 'gpt-4o-mini-2024',
  choices: [{ message: { role: 'assistant', content: 'Three bullets.' } }],
  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
};
const openaiParsed = parseResponse(OPENAI, openaiJson);
eq(openaiParsed.text, 'Three bullets.', 'parseResponse reads the openai answer');
eq(openaiParsed.model, 'gpt-4o-mini-2024', 'parseResponse reports the model');
eq(openaiParsed.usage.inputTokens, 12, 'parseResponse normalises the openai usage');
eq(openaiParsed.usage.outputTokens, 8, 'parseResponse normalises the openai output tokens');
eq(openaiParsed.usage.totalTokens, 20, 'parseResponse normalises the openai total tokens');

const geminiJson = {
  candidates: [{ content: { parts: [{ text: 'A note.' }] } }],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
};
const geminiParsed = parseResponse(GEMINI, geminiJson);
eq(geminiParsed.text, 'A note.', 'parseResponse reads the gemini answer');
eq(geminiParsed.usage.inputTokens, 5, 'parseResponse normalises the gemini usage');

const interJson = { output: [{ role: 'assistant', content: [{ type: 'text', text: 'Interaction answer.' }] }] };
eq(parseResponse(INTERACTIONS, interJson).text, 'Interaction answer.', 'parseResponse reads the interactions answer');
eq(
  parseResponse(preset({ kind: 'gemini-interactions', responseTextPath: 'output.0.content.0.text' }), interJson).text,
  'Interaction answer.',
  'responseTextPath reads the interactions answer',
);

const anthropicJson = {
  content: [
    { type: 'text', text: 'Claude says hello.' },
    { type: 'text', text: 'And again.' },
  ],
  usage: { input_tokens: 9, output_tokens: 4 },
};
const anthropicParsed = parseResponse(ANTHROPIC, anthropicJson);
eq(anthropicParsed.text, 'Claude says hello.\nAnd again.', 'parseResponse joins the anthropic blocks');
eq(anthropicParsed.usage.inputTokens, 9, 'parseResponse normalises the anthropic usage');
eq(anthropicParsed.usage.totalTokens, 13, 'parseResponse totals the anthropic usage');

eq(
  parseResponse(preset({ kind: 'raw', responseTextPath: 'answer.value' }), { answer: { value: 'Raw answer.' } }).text,
  'Raw answer.',
  'responseTextPath walks a dotted path for the raw kind',
);
eq(
  parseResponse(preset({ kind: 'raw', responseTextPath: 'choices.0.message.content' }), openaiJson).text,
  'Three bullets.',
  'responseTextPath can read an openai body for the raw kind',
);

throwsWithCode(() => parseResponse(OPENAI, { nothing: true }), 'parse', 'parseResponse rejects an unknown shape');
throwsWithCode(() => parseResponse(GEMINI, { candidates: [] }), 'parse', 'parseResponse rejects an empty candidate list');
throwsWithCode(
  () => parseResponse(preset({ kind: 'raw', responseTextPath: 'a.b.c' }), {}),
  'parse',
  'parseResponse rejects a responseTextPath that misses',
);

console.log('part 6 — status classification');

eq(classifyStatus(401, ''), 'invalid-key', '401 is an invalid key');
eq(classifyStatus(403, ''), 'invalid-key', '403 is an invalid key');
eq(classifyStatus(402, ''), 'out-of-credits', '402 is out of credit');
eq(classifyStatus(429, ''), 'rate-limited', '429 is rate limiting');
eq(classifyStatus(500, ''), 'server', '500 is a server error');
eq(classifyStatus(503, ''), 'server', '503 is a server error');
eq(classifyStatus(400, ''), 'server', 'an ordinary 400 is a server error');
eq(
  classifyStatus(400, JSON.stringify({ error: { message: 'API key not valid' } })),
  'invalid-key',
  'a 400 that names the key is an invalid key',
);

console.log('part 7 — the call path');

const unauthorized = makeFetch(async () => makeResponse({ status: 401, body: { error: { message: 'bad key' } } }));
await rejectsWithCode(
  () => callProvider(OPENAI, PAYLOAD, { fetchImpl: unauthorized }),
  'invalid-key',
  'a 401 becomes an invalid-key error',
);
eq(unauthorized.calls.length, 1, 'a 401 still only calls fetch once');

const limited = makeFetch(async () => makeResponse({ status: 429, body: { error: 'slow down' } }));
await rejectsWithCode(
  () => callProvider(OPENAI, PAYLOAD, { fetchImpl: limited }),
  'rate-limited',
  'a 429 becomes a rate-limited error',
);
eq(limited.calls.length, 1, 'a 429 still only calls fetch once');

const broken = makeFetch(async () => {
  throw new TypeError('Failed to fetch');
});
await rejectsWithCode(
  () => callProvider(OPENAI, PAYLOAD, { fetchImpl: broken }),
  'cors',
  'a rejected fetch becomes a cors error',
);
eq(broken.calls.length, 1, 'a rejected fetch is not retried');

try {
  await callProvider(OPENAI, PAYLOAD, { fetchImpl: broken });
} catch (err) {
  ok(err.message.includes('Test provider'), 'the cors message names the provider');
  ok(/proxy/i.test(err.message), 'the cors message says a proxy is needed');
  ok(!err.message.includes(KEY), 'the cors message has no key in it');
}

const good = makeFetch(async () => makeResponse({ body: openaiJson }));
const answer = await callProvider(OPENAI, PAYLOAD, { fetchImpl: good });
eq(answer.text, 'Three bullets.', 'a good body gives the text');
eq(answer.model, 'gpt-4o-mini-2024', 'a good body gives the model');
eq(answer.usage.totalTokens, 20, 'a good body gives the usage');
eq(answer.raw, openaiJson, 'a good body gives the raw json');
eq(good.calls.length, 1, 'callProvider calls fetch exactly once');
eq(good.calls[0].url, 'https://api.openai.com/v1/chat/completions', 'callProvider uses the built URL');
eq(good.calls[0].options.method, 'POST', 'callProvider POSTs');
eq(typeof good.calls[0].options.body, 'string', 'callProvider sends a JSON string body');
eq(JSON.parse(good.calls[0].options.body).model, 'gpt-4o-mini', 'callProvider sends the built body');

const aborted = makeFetch(async () => {
  const err = new Error('aborted');
  err.name = 'AbortError';
  throw err;
});
await rejectsWithCode(
  () => callProvider(OPENAI, PAYLOAD, { fetchImpl: aborted }),
  'aborted',
  'a cancelled request becomes an aborted error',
);

const jsonOnly = makeFetch(async () => ({
  ok: true,
  status: 200,
  json: async () => openaiJson,
}));
eq((await callProvider(OPENAI, PAYLOAD, { fetchImpl: jsonOnly })).text, 'Three bullets.', 'a response with only json() still parses');

const notJson = makeFetch(async () => makeResponse({ status: 200, text: 'not json at all' }));
await rejectsWithCode(
  () => callProvider(OPENAI, PAYLOAD, { fetchImpl: notJson }),
  'parse',
  'a body that is not JSON becomes a parse error',
);

const rawFetch = makeFetch(async () => makeResponse({ body: { answer: { value: 'Raw.' } } }));
const rawAnswer = await callProvider(
  preset({ kind: 'raw', responseTextPath: 'answer.value', requestTemplate: '{"p": {{prompt}}}' }),
  PAYLOAD,
  { fetchImpl: rawFetch },
);
eq(rawAnswer.text, 'Raw.', 'the raw kind goes through the same call path');
eq(typeof rawFetch.calls[0].options.body, 'string', 'the raw kind sends its template as a string');
eq(JSON.parse(rawFetch.calls[0].options.body).p, 'In three bullets.', 'the raw template reached the wire');

console.log('part 8 — no key in a URL');

for (const kind of PROVIDER_KINDS) {
  const p = preset({ kind, endpoint: describeKind(kind).defaultEndpoint || 'https://example.test/v1/ask' });
  const request = buildRequest(p, PAYLOAD);
  ok(!request.url.includes(KEY), `the ${kind} URL has no key in it`);
  ok(!JSON.stringify(request.headers).includes('?'), `the ${kind} headers carry no query string`);
}

const queryAuth = buildRequest(preset({ auth: 'query' }), PAYLOAD);
ok(queryAuth.url.includes('key='), 'the explicit query auth style is the one way a key reaches a URL');
ok(!queryAuth.headers.Authorization, 'the query auth style sends no authorization header');

console.log('part 9 — the model list');

const openaiModels = makeFetch(async () => makeResponse({ body: { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] } }));
eq(
  await fetchModels(OPENAI, { fetchImpl: openaiModels }),
  ['gpt-4o', 'gpt-4o-mini'],
  'fetchModels reads an openai model list',
);
eq(openaiModels.calls[0].options.method, 'GET', 'fetchModels GETs');
eq(openaiModels.calls[0].url, 'https://api.openai.com/v1/models', 'fetchModels uses the models URL');
eq(openaiModels.calls[0].options.headers.Authorization, `Bearer ${KEY}`, 'fetchModels sends the key as a header');

const geminiModels = makeFetch(async () =>
  makeResponse({ body: { models: [{ name: 'models/gemini-2.0-flash' }, { name: 'models/gemini-1.5-pro' }] } }),
);
eq(
  await fetchModels(GEMINI, { fetchImpl: geminiModels }),
  ['gemini-2.0-flash', 'gemini-1.5-pro'],
  'fetchModels reads a gemini model list and drops the models/ prefix',
);

const anthropicModels = makeFetch(async () => makeResponse({ body: { data: [{ id: 'claude-sonnet-4' }] } }));
eq(
  await fetchModels(ANTHROPIC, { fetchImpl: anthropicModels }),
  ['claude-sonnet-4'],
  'fetchModels reads an anthropic model list',
);

const brokenModels = makeFetch(async () => {
  throw new TypeError('Failed to fetch');
});
eq(await fetchModels(OPENAI, { fetchImpl: brokenModels }), [], 'a failed model list returns no models');
eq(
  await fetchModels(OPENAI, { fetchImpl: makeFetch(async () => makeResponse({ status: 500, body: 'boom' })) }),
  [],
  'a 500 model list returns no models',
);
eq(
  await fetchModels(OPENAI, { fetchImpl: makeFetch(async () => makeResponse({ body: { nothing: true } })) }),
  [],
  'an unreadable model list returns no models',
);
eq(await fetchModels(preset({ modelsUrl: '' }), { fetchImpl: makeFetch(async () => makeResponse({ body: {} })) }), [], 'a preset with no models URL returns no models');

console.log('part 10 — the error sentences');

ok(describeError(new AiError('invalid-key', 'x')) === 'That API key was rejected.', 'the invalid-key sentence');
ok(describeError(new AiError('out-of-credits', 'x')) === 'You are out of credit with that provider.', 'the out-of-credits sentence');
for (const code of ['invalid-key', 'rate-limited', 'out-of-credits', 'network', 'server', 'parse', 'cors', 'aborted']) {
  const sentence = describeError(new AiError(code, 'x', { provider: 'Groq' }));
  ok(typeof sentence === 'string' && sentence.length > 0, `describeError says something for ${code}`);
  ok(!sentence.includes(KEY), `the ${code} sentence has no key in it`);
}
ok(/proxy/i.test(describeError(new AiError('cors', 'x', { provider: 'Groq' }))), 'the cors sentence mentions a proxy');
ok(describeError(new AiError('cors', 'x', { provider: 'Groq' })).includes('Groq'), 'the cors sentence names the provider');
ok(describeError(null).length > 0, 'describeError copes with nothing at all');

console.log(`\n${failures === 0 ? 'ALL' : 'FAILED'} ${checks} CHECKS${failures === 0 ? ' PASSED' : ''}`);
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
