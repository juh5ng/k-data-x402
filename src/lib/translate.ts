import { cached } from "./cache";

/**
 * Korean→English headline translation via Workers AI.
 *
 * Untranslated Korean headlines are close to useless to a non-Korean agent —
 * the language barrier is the whole reason this niche exists.
 *
 * Two failure modes had to be engineered out before this was safe to sell:
 *
 * 1. Korean myriad units. Every model tested rendered "989억달러" as either
 *    "$989 billion" or "$9.89 billion"; the answer is $98.9 billion. Numeric
 *    scale is not something a data API may get wrong, so units are expanded
 *    deterministically here and the model never sees them.
 * 2. Proper nouns. The small translation model turned the official 김용범 into
 *    "Kim Jong-un" — a fabricated figure, worse than no translation at all.
 *    The instruct model below transliterates names literally instead.
 *
 * The original Korean title always travels alongside the translation, so a
 * caller can verify anything that matters.
 */

/** Instruct model: correct on proper nouns, unlike the dedicated MT model. */
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/** Keep concurrent model calls bounded so one request can't stall on a burst. */
const CONCURRENCY = 4;

const SYSTEM_PROMPT = [
  "You translate Korean news headlines into English.",
  "Rules:",
  "- Output ONLY the translated headline. No commentary, no quotes around the whole line, no explanation.",
  "- Copy every number, unit and percentage exactly as given. Never rescale or round them.",
  "- Never invent, substitute or 'correct' a proper noun. Transliterate Korean personal names literally (김용범 -> Kim Yong-beom).",
  "- If a term is an abbreviation or slang you cannot resolve, transliterate it rather than guessing a meaning.",
].join("\n");

const MYRIAD: Record<string, number> = { 조: 1e12, 억: 1e8, 만: 1e4 };

function humanize(value: number): string {
  const trim = (n: number) => String(+n.toFixed(2));
  if (value >= 1e12) return `${trim(value / 1e12)} trillion`;
  if (value >= 1e9) return `${trim(value / 1e9)} billion`;
  if (value >= 1e6) return `${trim(value / 1e6)} million`;
  return value.toLocaleString("en-US");
}

/**
 * Rewrites Korean myriad-grouped numbers into plain English magnitudes.
 * "989억" -> "98.9 billion", "1조2000억" -> "1.2 trillion".
 * Runs before translation so the model only has to carry a number across,
 * never convert one.
 */
export function expandKoreanNumerals(text: string): string {
  return text.replace(/(?:\d[\d,.]*\s*[조억만])+/g, run => {
    let total = 0;
    let matched = false;
    for (const [, digits, unit] of run.matchAll(/(\d[\d,.]*)\s*([조억만])/g)) {
      const n = parseFloat(digits.replace(/,/g, ""));
      if (!Number.isFinite(n)) return run;
      total += n * MYRIAD[unit];
      matched = true;
    }
    return matched && total > 0 ? humanize(total) : run;
  });
}

async function translateOne(ai: Ai, text: string): Promise<string | null> {
  // Cache on the raw headline: the same titles recur across requests and feeds,
  // and every hit is a model call not made.
  return cached(`tr:${text}`, 6 * 60 * 60_000, async () => {
    try {
      const prepared = expandKoreanNumerals(text);
      const res = await ai.run(MODEL as Parameters<Ai["run"]>[0], {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prepared },
        ],
        max_tokens: 160,
        temperature: 0,
      } as Parameters<Ai["run"]>[1]);
      const raw = (res as { response?: string })?.response;
      if (typeof raw !== "string") return null;
      const cleaned = raw.trim().replace(/^["'“‘]|["'”’]$/g, "").trim();
      return cleaned || null;
    } catch {
      return null;
    }
  });
}

/**
 * Translates a batch of headlines, preserving order.
 * Failures come back as `null` rather than throwing — a missing translation
 * should degrade one field, not fail the paid request the caller just bought.
 */
export async function translateKoToEn(ai: Ai, texts: string[]): Promise<(string | null)[]> {
  const out: (string | null)[] = new Array(texts.length).fill(null);
  for (let i = 0; i < texts.length; i += CONCURRENCY) {
    const slice = texts.slice(i, i + CONCURRENCY);
    const done = await Promise.all(slice.map(t => translateOne(ai, t)));
    done.forEach((v, j) => (out[i + j] = v));
  }
  return out;
}
