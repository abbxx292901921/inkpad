# inkpad-proxy — the Inkpad AI proxy

A Cloudflare Worker that relays an AI provider call for the Inkpad notes app
and adds the API key on the way through.

**WHY:** OpenAI, Anthropic and NVIDIA NIM send no `Access-Control-Allow-Origin`
header, so a browser cannot call them with a key — the request is blocked
before it leaves the page, and `src/ai/client.js` reports that as a `cors`
error. A worker on the far side of the CORS line has no such problem.

The app does not change: it still builds the request exactly as it always did
(`src/ai/providers.js`), sends it to the worker, and reads the answer out of
the reply. The worker only rewrites the address and attaches the key.

* **Style:** a Cloudflare **module worker** — `export default { fetch }`.
* **Dependencies:** none. Only the Workers runtime (`fetch`, `Request`,
  `Response`, `URL`, `Headers`).
* **Secrets:** none in the code. Everything comes from environment bindings.
* **Logging:** none. The request body is a conversation with a model, and in a
  note-taking app that is the user's own content.

---

## Deploy

### The dashboard (no tooling)

1. Cloudflare → **Workers & Pages** → **Create** → **Start with Hello World!**
   → name it `inkpad-proxy` → **Deploy**.
2. **Edit code** → delete the sample → paste the whole of
   `worker/inkpad-proxy.js` → **Deploy**.
3. **Settings** → **Variables and Secrets** → add the bindings below
   (a *variable* is visible in the dashboard, a *secret* is not).
4. Copy the worker URL: `https://inkpad-proxy.<your-subdomain>.workers.dev`

### wrangler

Save this as `worker/wrangler.toml` (next to `inkpad-proxy.js`):

```toml
name = "inkpad-proxy"
main = "inkpad-proxy.js"
compatibility_date = "2024-11-01"

# The provider that serves a request which names none.
[vars]
DEFAULT_PROVIDER = "nvidia-nim"

# The provider map. The key is NOT here: `keyEnv` names a secret binding.
PROVIDERS = "{\"nvidia-nim\": {\"base\": \"https://integrate.api.nvidia.com/v1\", \"keyEnv\": \"NVIDIA_NIM_KEY\", \"auth\": \"bearer\", \"models\": \"https://integrate.api.nvidia.com/v1/models\"}}"

# The key itself (a secret, not a variable):
#   npx wrangler secret put NVIDIA_NIM_KEY
#
# The shared secret the app must present (a secret, not a variable):
#   npx wrangler secret put PROXY_SECRET
```

Then:

```bash
cd worker
npx wrangler secret put NVIDIA_NIM_KEY
npx wrangler secret put PROXY_SECRET
npx wrangler deploy
```

---

## The bindings

| Binding | Type | Shape | Meaning |
|---|---|---|---|
| `PROVIDERS` | variable (or secret) | a JSON object, one key per provider | the providers this worker may reach |
| `DEFAULT_PROVIDER` | variable | a provider name | the provider for a request that names none |
| `PROXY_SECRET` | **secret** | any string | if set, a request must carry `x-inkpad-secret` with the same value, or it gets a 403 |
| `<any name>` | **secret** | any string | a provider's key, when its `keyEnv` names it |

A provider entry:

```json
{
  "base": "https://integrate.api.nvidia.com/v1",
  "key": "nvapi-...",
  "keyEnv": "NVIDIA_NIM_KEY",
  "auth": "bearer",
  "models": "https://integrate.api.nvidia.com/v1/models"
}
```

| Field | Meaning |
|---|---|
| `base` | the provider URL the app's path is appended to. **Required.** |
| `key` | the API key, inline. Use this only if `PROVIDERS` itself is a **secret**. |
| `keyEnv` | the name of another binding that holds the key. Use this to keep `PROVIDERS` a plain variable. `key` wins if both are set. |
| `auth` | how the key is attached: `bearer` (the default), `x-api-key`, `x-goog-api-key`, `query` or `none`. The same five styles `src/ai/presets.js` knows. |
| `models` | where the model list lives. Optional — `<base>/models` is used when it is missing. |

**Choosing `base`:** the app appends a path to the endpoint, and the worker
appends the rest of the path to `base`. So `base` is whatever makes
`base + app path` the real provider URL:

| The app's kind | the app appends | `base` should be |
|---|---|---|
| OpenAI-compatible (OpenAI, NVIDIA NIM, Groq, Mistral…) | `/chat/completions` | `https://integrate.api.nvidia.com/v1` |
| Anthropic | `/v1/messages` | `https://api.anthropic.com` |
| Google Gemini | `/models/<model>:generateContent` | `https://generativelanguage.googleapis.com/v1beta` |

---

## The two URL shapes

### `/<provider-key>/<path...>` — the safe form

The worker rewrites the path onto that provider's `base`:

```
POST https://inkpad-proxy.example.workers.dev/nvidia-nim/chat/completions
  ->  POST https://integrate.api.nvidia.com/v1/chat/completions
        Authorization: Bearer <the key from the binding>
```

This form can only ever reach a **configured** provider. A provider name that
does not exist is a `404`, never a fall back to another provider — a typo must
not quietly send one provider's key to another provider's address.

### `x-inkpad-target` — the flat form

```
POST https://inkpad-proxy.example.workers.dev/v1/chat/completions
  x-inkpad-provider: nvidia-nim
  x-inkpad-target: https://integrate.api.nvidia.com/v1/chat/completions
  ->  POST https://integrate.api.nvidia.com/v1/chat/completions
```

The URL is used as it is. The provider (`x-inkpad-provider`, or
`DEFAULT_PROVIDER`) still decides which key is attached. **See the security
note below — this form is an open relay unless `PROXY_SECRET` is set.**

### The model list

```
GET https://inkpad-proxy.example.workers.dev/nvidia-nim/__models
  ->  GET https://integrate.api.nvidia.com/v1/models   (with the key)
```

---

## In Inkpad

Settings → the provider preset:

| Field | Value |
|---|---|
| Kind | the same kind you would use without the proxy (OpenAI-compatible, Anthropic, Google Gemini…) |
| Endpoint | `https://inkpad-proxy.<your-subdomain>.workers.dev/nvidia-nim` |
| API key | **leave it empty** — the worker adds the key |
| Auth | the same style as the worker's `auth` (an empty key means the app sends no key header at all) |
| Models URL | `https://inkpad-proxy.<your-subdomain>.workers.dev/nvidia-nim/__models` (optional, but it is how "Fetch models" reaches the provider) |
| Extra headers | `x-inkpad-secret: <your PROXY_SECRET>` — only if you set one |

So the endpoint in the app becomes `<worker-url>/<provider-key>`, the app's own
key field can be left empty, and the key never reaches the browser.

The worker also **replaces** an `Authorization`, `x-api-key` or
`x-goog-api-key` header the app sent: a key left over in the app cannot
override the server's key, and it is never forwarded.

---

## Proving it works

```bash
WORKER=https://inkpad-proxy.<your-subdomain>.workers.dev

# 1. the deployment is alive
curl -sS "$WORKER/health"
# {"ok":true}

# 2. a real call, through the proxy (add -H 'x-inkpad-secret: ...' if you
#    set PROXY_SECRET)
curl -sS "$WORKER/nvidia-nim/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"meta/llama-3.3-70b-instruct","messages":[{"role":"user","content":"say hi"}]}'
# {"choices":[{"message":{"role":"assistant","content":"hi"}}],...}

# 3. the model list
curl -sS "$WORKER/nvidia-nim/__models"

# 4. the flat form
curl -sS "$WORKER/v1/chat/completions" \
  -H 'x-inkpad-provider: nvidia-nim' \
  -H 'x-inkpad-target: https://integrate.api.nvidia.com/v1/chat/completions' \
  -H 'content-type: application/json' \
  -d '{"model":"meta/llama-3.3-70b-instruct","messages":[{"role":"user","content":"say hi"}]}'
```

---

## What comes back

| Situation | Answer |
|---|---|
| The provider answered | its status, its body, its content type, plus the CORS headers |
| The provider said no (4xx, 5xx) | **its** status, the first **500 characters** of its body, and an `x-inkpad-error: 1` header |
| The provider could not be reached | `502` and `{"error": "upstream unreachable"}` — no `x-inkpad-error` header, so the app can tell a provider error from a proxy error |
| The provider name is not configured | `404` and `{"error": "unknown provider", "provider": "…", "providers":[…]}` |
| The secret is wrong or missing | `403` and `{"error": "forbidden"}` |
| The method is not GET or POST | `405` |
| A preflight | `204` with the CORS headers |

CORS, on every answer: `Access-Control-Allow-Origin: *`,
`Access-Control-Allow-Methods: GET, POST, OPTIONS` and
`Access-Control-Allow-Headers: content-type, x-inkpad-provider,
x-inkpad-target, x-inkpad-secret, authorization`.

The key never appears in a response body, a log line or an error message: if a
provider echoes it back, it is replaced with `[redacted]`.

---

## SECURITY

**The worker is a proxy, and the flat form will relay a request to whatever
`x-inkpad-target` says.** With `PROXY_SECRET` unset, anyone who finds the
worker URL can spend your provider's key on anything they like — an open
relay with your credit card behind it.

So:

1. **Always set `PROXY_SECRET`**, and give the app the matching
   `x-inkpad-secret` header (Settings → the preset → *Extra headers*).
2. **Prefer the `/<provider-key>/<path>` form.** It can only reach the
   providers you configured, so it cannot be turned into a relay at all. Use
   the flat `x-inkpad-target` form only when there is no other way.
3. `PROXY_SECRET` is compared in constant time, and a wrong secret never
   reaches a provider.
4. The worker logs nothing, forwards no cookies, and drops the `cf-*` headers.
5. A provider name that does not exist is a `404` — it never falls back to
   another provider, so a typo cannot send the wrong key to the wrong host.
6. Rotate the provider's key if the worker URL leaks. The worker URL is not a
   secret of its own, but it is a key dispenser.

---

## The tests

```bash
node tests/inkpad-worker-test.mjs
```

The suite drives the worker's default export with a fake `fetch`, so no
request ever leaves the machine. It covers the path rewrite, every auth
style, the client's key being replaced, the health check, the preflight, the
error mapping, the 502, the 404, the 403 and the redaction of the key.
