import type { FieldObservationInput, GrainCardClass } from "./field-update";

/**
 * BLOCK 6, rebuild phase 9 continued - the chat/conversational layer the
 * original plan's point 3 asked for ("on-site update through the chat
 * bot"), on top of the deterministic structured-form version
 * (lib/field-update.ts) already built in phase 7.
 *
 * The project's standing rule is explicit: AI explains and consolidates,
 * it never scores. Applied here as literally as possible - this module
 * PARSES free text into the exact same structured fields
 * FieldObservationInput already takes, then hands them to
 * psdFromFieldObservation UNCHANGED. It never computes a PSD, a category,
 * or a confidence itself.
 *
 * The parser below is a deterministic, keyword/pattern matcher, not a
 * call to an LLM: this project has no AI SDK dependency and no key for one
 * wired in anywhere, and a free-text field report ("looks like fine sand,
 * cleared in about ten minutes") is regular enough in practice that a
 * small set of patterns covers it without one. If real usage shows people
 * phrasing things this can't follow, swapping in a real LLM call is a
 * drop-in replacement AT THIS EXACT BOUNDARY - parseFreeTextObservation's
 * return shape would not need to change, because the rule it already
 * follows (parse into these fields, never score) is the rule an LLM would
 * have to follow too.
 */

export interface ChatIntakeResult {
  input: FieldObservationInput;
  /** Plain-English account of what was matched and from which phrase - shown back to the user so a bad match is obvious, not silent. */
  parsedFrom: string[];
  /** What the message didn't contain, or couldn't be read confidently - never silently guessed instead. */
  warnings: string[];
}

/**
 * Every qualified class a grain-card reading can name. The bare "sand"
 * fallback is handled separately below, not in this list - it must never
 * compete with "fine sand"/"coarse sand"/etc. by text position, only apply
 * when NONE of these matched anywhere in the message.
 */
const GRAIN_CARD_PATTERNS: { pattern: RegExp; cls: GrainCardClass; label: string }[] = [
  { pattern: /\bgravel\b/gi, cls: "gravel", label: "gravel" },
  { pattern: /\bcoarse[\s-]*sand\b/gi, cls: "coarse_sand", label: "coarse sand" },
  { pattern: /\bmedium[\s-]*sand\b/gi, cls: "medium_sand", label: "medium sand" },
  { pattern: /\bfine[\s-]*sand\b/gi, cls: "fine_sand", label: "fine sand" },
  { pattern: /\bsilt(?:y)?\b/gi, cls: "silt", label: "silt" },
  { pattern: /\bclay(?:ey)?\b/gi, cls: "clay", label: "clay" },
];
/** No size qualifier - medium sand is the middle of the three sand classes, the least-wrong single guess. Only used when nothing in the list above matched anywhere in the message. */
const BARE_SAND_PATTERN = /\bsandy?\b/gi;

/** The LAST match of `pattern` in `message` by text position, not pattern-list order - a correction later in a short field note should win regardless of which pattern happens to be checked first. */
function lastMatch(pattern: RegExp, message: string): { index: number; text: string } | null {
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((m = pattern.exec(message))) last = m;
  return last ? { index: last.index, text: last[0] } : null;
}

const CLEARED_PATTERN =
  /(?:clear(?:ed)?|settl(?:ed|es))\s*(?:up|out)?\s*(?:within|in|after)?\s*(?:about|around|roughly)?\s*(\d+(?:\.\d+)?)\s*(min(?:ute)?s?)\b/i;

const PERSISTENT_HAZE_PATTERN =
  /(?:still\s+haz(?:y|e)|(?:didn['’]?t|did\s+not|hasn['’]?t|has\s+not)\s+clear(?:ed)?|remain(?:ed|s)?\s+haz(?:y|e)|staye?d\s+haz(?:y|e))[\s\S]{0,30}?(\d+(?:\.\d+)?)\s*(hours?|hrs?)\b/i;

const TURBIDITY_TUBE_PATTERN = /turbidity\s*tube[\s\S]{0,15}?(\d+(?:\.\d+)?)\s*cm\b/i;
/** Fallback: a bare "<number> cm" with the word "turbidity" anywhere in the message, in either order. */
const BARE_CM_PATTERN = /(\d+(?:\.\d+)?)\s*cm\b/i;

/**
 * Turns a free-text field report into the same structured fields the form
 * takes. Deliberately conservative: a phrase that doesn't match a pattern
 * is left unset and reported in `warnings`, never guessed at. Multiple
 * grain-card classes mentioned in one message (e.g. correcting oneself
 * mid-sentence) take the LAST match, on the reasonable assumption that a
 * later statement in a short field note is a correction of an earlier one,
 * not a second, equally-weighted observation.
 */
export function parseFreeTextObservation(message: string): ChatIntakeResult {
  const parsedFrom: string[] = [];
  const warnings: string[] = [];
  const input: FieldObservationInput = { siteNote: message.trim() };

  let grainMatch: { cls: GrainCardClass; label: string; text: string; index: number } | undefined;
  for (const { pattern, cls, label } of GRAIN_CARD_PATTERNS) {
    const found = lastMatch(pattern, message);
    if (found && (!grainMatch || found.index > grainMatch.index)) {
      grainMatch = { cls, label, text: found.text, index: found.index };
    }
  }
  if (!grainMatch) {
    const bare = lastMatch(BARE_SAND_PATTERN, message);
    if (bare) grainMatch = { cls: "medium_sand", label: "sand (no size given - read as medium sand)", text: bare.text, index: bare.index };
  }
  if (grainMatch) {
    input.grainCardClass = grainMatch.cls;
    parsedFrom.push(`Grain-card class "${grainMatch.label}" from "${grainMatch.text}".`);
  } else {
    warnings.push("No grain-card size class recognised (e.g. \"clay\", \"silt\", \"fine sand\", \"gravel\") - nothing size-relevant to recompute from unless one is given.");
  }

  const clearedMatch = message.match(CLEARED_PATTERN);
  const hazeMatch = message.match(PERSISTENT_HAZE_PATTERN);
  if (clearedMatch && hazeMatch) {
    // Genuinely contradictory phrasing in one message ("cleared in 5
    // minutes... still hazy after 2 hours") - report it rather than
    // silently picking one, the same discipline lib/field-update.ts
    // itself uses for a grain-card/settle-test disagreement.
    warnings.push(`The message mentions both a rapid clear ("${clearedMatch[0]}") and a persistent haze ("${hazeMatch[0]}") - too contradictory to read as one settle-test result, so neither was used. Describe the settle test as a single outcome.`);
  } else if (clearedMatch) {
    const minutes = Number(clearedMatch[1]);
    input.settleTest = { clearedWithinMinutes: minutes, observedForHours: null };
    parsedFrom.push(`Settle test: cleared within ${minutes} minutes, from "${clearedMatch[0]}".`);
  } else if (hazeMatch) {
    const hours = Number(hazeMatch[1]);
    input.settleTest = { clearedWithinMinutes: null, observedForHours: hours };
    parsedFrom.push(`Settle test: still hazy after ${hours} hours, from "${hazeMatch[0]}".`);
  }

  const tubeMatch = message.match(TURBIDITY_TUBE_PATTERN) ?? (/turbidity/i.test(message) ? message.match(BARE_CM_PATTERN) : null);
  if (tubeMatch) {
    input.turbidityTubeReadingCm = Number(tubeMatch[1]);
    parsedFrom.push(`Turbidity tube reading: ${tubeMatch[1]} cm, from "${tubeMatch[0]}".`);
  }

  if (parsedFrom.length === 0) {
    warnings.push("Nothing in this message matched a grain-card class, a settle-test timing, or a turbidity-tube reading. Try describing what was actually seen, e.g. \"looks like fine sand, cleared within 10 minutes.\"");
  }

  return { input, parsedFrom, warnings };
}
