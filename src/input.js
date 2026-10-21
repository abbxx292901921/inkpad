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
//   explicit === null   -> finger draws UNTIL a pen is seen; after that it
//                          stops. Default, needs no user action.
//   explicit === true   -> finger always draws ("Pen + finger").
//   explicit === false  -> finger never draws ("Pen only").
// The user's explicit choice wins permanently once made; until then the auto
// rule applies. Mouse is never affected — desktop has no palm problem.
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
  let explicit = null; // null = no explicit choice yet | true | false
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
      if (parsed && typeof parsed.fingerDrawing === 'boolean') return parsed.fingerDrawing;
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

  // True when a finger is currently allowed to draw.
  function fingerDrawingEnabled() {
    if (explicit !== null) return explicit;
    return !penDetected;
  }

  // Flip the user's explicit preference. Returns the new effective state.
  function toggleFingerDrawing() {
    explicit = !fingerDrawingEnabled();
    writeStoredChoice(explicit);
    emit();
    return fingerDrawingEnabled();
  }

  // Set the user's explicit preference directly. `true` = fingers always
  // draw, `false` = fingers never draw. Passing `null` clears it and returns
  // to the automatic rule.
  function setFingerDrawing(value) {
    if (value === null) {
      explicit = null;
      const s = safeStorage();
      if (s && persist) {
        try {
          s.removeItem(STORAGE_KEY);
        } catch {
          // ignore
        }
      }
    } else {
      explicit = !!value;
      writeStoredChoice(explicit);
    }
    emit();
    return fingerDrawingEnabled();
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
export const toggleFingerDrawing = () => defaultInput.toggleFingerDrawing();
export const setFingerDrawing = (v) => defaultInput.setFingerDrawing(v);
export const resetFingerDrawing = () => defaultInput.resetFingerDrawing();
export const getInputState = () => defaultInput.getInputState();
export const subscribeInput = (fn) => defaultInput.subscribe(fn);
