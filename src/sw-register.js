// sw-register.js — register the service worker that makes Inkpad offline.
//
// WHY: Inkpad is a static site with no backend, so the only way it can open
// without a network is a service worker holding a copy of the app shell. This
// module is the ONLY place that talks to navigator.serviceWorker, so the rest
// of the app never has to know whether it is running offline.
//
// SUBPATH SAFETY: both the script URL and the scope are derived from
// import.meta.url, so the app works unchanged under
// https://<user>.github.io/inkpad/ and from a plain folder on disk.
//
// Registration is best-effort. A refused registration (no HTTPS, a browser
// without service workers, a blocked script) must never stop the app from
// starting — it just means the app is not cached and needs the network.

// sw.js sits in the app root, next to index.html.
const SW_URL = new URL('../sw.js', import.meta.url);
// The scope is the app root itself, so every file of the app is controlled.
const SCOPE_URL = new URL('./', SW_URL);

// Register the service worker.
//
// onUpdate(registration) is called when a NEW worker has installed but an
// older one is still in charge — the moment to offer "reload for the new
// version". Call applyUpdate(registration) to let the new worker take over.
//
// Returns a Promise for the registration (or null if there is no service
// worker to register).
export function registerServiceWorker({ onUpdate } = {}) {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return null;
  // Service workers need a secure context. http://localhost counts as one,
  // so local testing works; a plain http:// LAN address does not, and that is
  // fine — the app still runs, it just is not cached.
  if (!window.isSecureContext) return null;

  return navigator.serviceWorker
    .register(SW_URL.href, { scope: SCOPE_URL.href })
    .then((registration) => {
      watchForUpdate(registration, onUpdate);
      return registration;
    })
    .catch((err) => {
      console.warn('[inkpad] service worker registration failed (non-fatal)', err);
      return null;
    });
}

// Let the waiting worker take over. Resolves true once it has, at which
// point the page should reload to run the new code.
export function applyUpdate(registration) {
  const waiting = registration && registration.waiting;
  if (!waiting) return Promise.resolve(false);
  return new Promise((resolve) => {
    navigator.serviceWorker.addEventListener('controllerchange', () => resolve(true), {
      once: true,
    });
    waiting.postMessage({ type: 'SKIP_WAITING' });
  });
}

// Report an update the user can accept.
function watchForUpdate(registration, onUpdate) {
  if (typeof onUpdate !== 'function') return;

  // A worker that finished installing while the page was closed is already
  // waiting: offer the update straight away.
  if (registration.waiting && navigator.serviceWorker.controller) {
    onUpdate(registration);
    return;
  }

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      // 'installed' while a controller exists means an OLDER worker is still
      // in charge, so the new one waits for the user to accept it. With no
      // controller the new worker simply activates — a first install.
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        onUpdate(registration);
      }
    });
  });
}
