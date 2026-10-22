// input.js — pointer arbitration: decides which pointer types are allowed to
// draw.
//
// WHY: on iPad the Apple Pencil and the user's hand arrive as different
// `pointerType` values ('pen' vs 'touch'), so the distinction IS available to
// the web — no pairing required. But iPadOS's own palm rejection is not
// reliable inside a web view: a hand already resting on the screen can emit
// pointerdown/pointermove and leave ink behind. (This is the "wrist-down
// causes 10 straight strokes" bug reported against atrament.js#53, and the
// reason Excalidraw ships a pen-mode toggle — excalidraw/excalidraw#4657.)
//
// POLICY (the Excalidraw "pen mode" pattern, persisted across reloads):
//   explicit === 'on'   -> a finger DRAWS, always
//   explicit === 'off'  -> a finger is ignored entirely
//   explicit === null   -> AUTOMATIC: a finger draws until the Pencil is
//                          seen, and after that a finger PANS the page
//                          (one finger is enough to scroll), because a
//                          hand resting on the screen while you write with
//                          the Pencil must not leave ink behind, but it
//                          should still be able to move the page.
//
// The user's explicit choice wins permanently once made; until then the
// automatic rule applies. Mouse is never affected — desktop has no palm
// problem.
//
// Storage key: `inkpad.input.v1`.

const STORAGE_KEY = 'inkpad.input.v1';

function safeStorage() {
  try {
    if (typeof window === 'undefined') return null;
    const s = window.localStorage;
    if (!s) return null;
    return s;
  } catch {
    // Storage can throw in private mode / blocked cookies.
    return null;
  }
}

// Creates an ISOLATED input policy. The app uses the module-level default
// instance below; tests create their own so one test cannot leak state into
// the next.
export function createInputPolicy({ persist = true } = {}) {
  // null = no explicit choice yet | 'on' | 'off'
  let explicit = null;
  let penDetected = false;
  const listeners = new Set();

  function readStoredChoice() {
    if (!persist) return null;
    const s = safeStorage();
    if (!s) return null;
    try {
      const raw = s.getItem(STORAGE_KEY);
      if (raw === null) return null;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.fingerDrawing === 'boolean') {
        return parsed.fingerDrawing ? 'on' : 'off';
      }
      if (parsed && typeof parsed.fingerDrawing === 'string') {
        if (parsed.fingerDrawing === 'on' || parsed.fingerDrawing === 'off') {
          return parsed.fingerDrawing;
        }
      }
    } catch {
      // ignore malformed data
    }
    return null;
  }

  function writeStoredChoice(value) {
    if (!persist) return;
    const s = safeStorage();
    if (!s) return;
    try {
      s.setItem(STORAGE_KEY, JSON.stringify({ fingerDrawing: value }));
    } catch {
      // Non-fatal: the setting just will not survive a reload.
    }
  }

  explicit = readStoredChoice();

  function getInputState() {
    return {
      explicit,
      penDetected,
      fingerDrawing: fingerDrawingEnabled(),
      fingerAction: fingerAction(),
    };
  }

  function emit() {
    for (const fn of listeners) {
      try {
        fn(getInputState());
      } catch (err) {
        console.warn('[inkpad] input listener failed (non-fatal)', err);
      }
    }
  }

  // Call the moment a pen event of ANY kind is seen (contact or hover). This
  // is what arms the auto palm-rejection rule.
  function notePenSeen() {
    if (penDetected) return false;
    penDetected = true;
    emit();
    return true;
  }

  function isPenDetected() {
    return penDetected;
  }

  // True when a finger is allowed to draw.
  function fingerDrawingEnabled() {
    return fingerAction() === 'draw';
  }

  // What a finger does RIGHT NOW: 'draw' | 'pan' | 'none'.
  function fingerAction() {
    if (explicit === 'on') return 'draw';
    if (explicit === 'off') return 'none';
    // Automatic: a finger draws until the Pencil is in use; after that it
    // pans the page instead, so one finger is enough to scroll.
    return penDetected ? 'pan' : 'draw';
  }

  // Cycle the preference: automatic -> always draws -> ignored -> automatic.
  function toggleFingerDrawing() {
    const order = [null, 'on', 'off'];
    const next = order[(order.indexOf(explicit) + 1) % order.length];
    explicit = next;
    if (next === null) {
      const s = safeStorage();
      if (s && persist) {
        try {
          s.removeItem(STORAGE_KEY);
        } catch {
          // ignore
        }
      }
    } else {
      writeStoredChoice(next);
    }
    emit();
    return fingerAction();
  }

  // Set the preference directly: 'on' | 'off' | null (automatic).
  // `true`/`false` are accepted as 'on'/'off'.
  function setFingerDrawing(value) {
    const next = value === true ? 'on' : value === false ? 'off' : value;
    if (next === 'on' || next === 'off') {
      explicit = next;
      writeStoredChoice(next);
    } else {
      explicit = null;
      const s = safeStorage();
      if (s && persist) {
        try {
          s.removeItem(STORAGE_KEY);
        } catch {
          // ignore
        }
      }
    }
    emit();
    return fingerAction();
  }

  // Back to the automatic rule (finger draws until a pen appears).
  function resetFingerDrawing() {
    explicit = null;
    const s = safeStorage();
    if (s && persist) {
      try {
        s.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    }
    emit();
    return fingerDrawingEnabled();
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    notePenSeen,
    isPenDetected,
    fingerDrawingEnabled,
    fingerAction,
    toggleFingerDrawing,
    setFingerDrawing,
    resetFingerDrawing,
    getInputState,
    subscribe,
  };
}

// The app-wide default policy.
export const defaultInput = createInputPolicy();

export const notePenSeen = () => defaultInput.notePenSeen();
export const isPenDetected = () => defaultInput.isPenDetected();
export const fingerDrawingEnabled = () => defaultInput.fingerDrawingEnabled();
export const fingerAction = () => defaultInput.fingerAction();
export const toggleFingerDrawing = () => defaultInput.toggleFingerDrawing();
export const setFingerDrawing = (v) => defaultInput.setFingerDrawing(v);
export const resetFingerDrawing = () => defaultInput.resetFingerDrawing();
export const getInputState = () => defaultInput.getInputState();
export const subscribeInput = (fn) => defaultInput.subscribe(fn);
