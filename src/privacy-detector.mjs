// src/privacy-detector.mjs
// Privacy-marker detection — port of the Hermes plugin's `privacy.py`, which
// is itself a port of the canonical TypeScript source at
// the-librarian/integrations/shared/librarian-lifecycle/src/privacy.ts.
//
// Pure phrase matching, never a semantic classifier. Why: a missed marker
// leaks nothing on its own (the next obvious marker will trip), but a false
// positive on ordinary prose would silently stop recording. So this code is
// dead simple by design.
//
// Marker lists MUST stay in sync with the TS source. The matrix in
// tests/privacy-detector.test.mjs mirrors privacy.test.ts and is the parity
// gate.

export const DEFAULT_PRIVATE_MARKERS = Object.freeze([
  "this is a private session",
  "don't remember this",
  "do not remember this",
  "don't save this",
  "do not save this",
  "don't store this",
  "off the record",
  "keep this between us",
  "private from here",
]);

export const DEFAULT_PUBLIC_MARKERS = Object.freeze([
  "you can remember again",
  "end private mode",
  "back on the record",
  "this can be remembered",
]);

export const TOGGLE_COMMANDS = Object.freeze(["/lib-toggle-private", "/lib:toggle-private"]);

// Trailing punctuation ("off the record.") is not substantive; real content
// is. The 3-char floor lets short filler read as a bare marker while any
// genuine instruction trips it. Both directions of error fail safe: over-
// reporting "substantive content" means we decline to record the turn — the
// privacy-biased choice.
const SUBSTANTIVE_MIN_CHARS = 3;
const NON_ALNUM_GLOBAL = /[^a-z0-9]+/g;

function normalise(text) {
  // NFKC folds compat forms; manual replace handles smart quotes that NFKC
  // leaves alone. Lowercase last because U+2019 has no case.
  return (text ?? "").normalize("NFKC").replace(/[‘’]/g, "'").toLowerCase();
}

function hasSubstantiveRemainder(normalisedPrompt, normalisedMarker) {
  // Removing only the first occurrence is deliberate: if a marker repeats,
  // the leftover copies inflate the count toward "substantive" — i.e. toward
  // not recording the turn, the safe direction.
  const idx = normalisedPrompt.indexOf(normalisedMarker);
  const without =
    idx === -1
      ? normalisedPrompt
      : `${normalisedPrompt.slice(0, idx)} ${normalisedPrompt.slice(idx + normalisedMarker.length)}`;
  return without.replace(NON_ALNUM_GLOBAL, "").length >= SUBSTANTIVE_MIN_CHARS;
}

function firstMatch(normalisedPrompt, markers) {
  for (const marker of markers) {
    if (normalisedPrompt.includes(normalise(marker))) return marker;
  }
  return null;
}

export function detectPrivacySignal(prompt, { privateMarkers, publicMarkers } = {}) {
  const normalised = normalise(prompt);
  const trimmed = normalised.trim();

  if (TOGGLE_COMMANDS.includes(trimmed)) {
    return { signal: "toggle", matched: trimmed, hasSubstantiveContent: false };
  }

  const privates = privateMarkers ?? DEFAULT_PRIVATE_MARKERS;
  const enter = firstMatch(normalised, privates);
  if (enter !== null) {
    return {
      signal: "enter-private",
      matched: enter,
      hasSubstantiveContent: hasSubstantiveRemainder(normalised, normalise(enter)),
    };
  }

  const publics = publicMarkers ?? DEFAULT_PUBLIC_MARKERS;
  const exit = firstMatch(normalised, publics);
  if (exit !== null) {
    return {
      signal: "exit-private",
      matched: exit,
      hasSubstantiveContent: hasSubstantiveRemainder(normalised, normalise(exit)),
    };
  }

  return { signal: "none", matched: null, hasSubstantiveContent: false };
}
