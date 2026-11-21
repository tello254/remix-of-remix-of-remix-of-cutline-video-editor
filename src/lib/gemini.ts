/**
 * The one model call Cutline makes itself: polishing the narration script.
 *
 * The key comes from `VITE_GEMINI_API_KEY` so no secret is committed. Vite
 * inlines it into the browser bundle, so only a free-tier key with no billing
 * attached belongs in that variable, and it should be rotated when abused or
 * when the quota runs out. Local development reads it from `.env.local`; the
 * deployed app needs the same variable set in Lovable or the host.
 */

export const GEMINI_MODEL = "gemini-3.5-flash-lite";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/** Trimmed key, or a sentence the UI can show instead of a failed request. */
function geminiKey() {
  const key = (import.meta.env["VITE_GEMINI_API_KEY"] ?? "").trim();
  if (!key) {
    throw new Error(
      "No Gemini key is configured. Add VITE_GEMINI_API_KEY to .env.local, or set it in Lovable.",
    );
  }
  return key;
}

export const POLISH_INSTRUCTIONS = `You are a script editor for short explainer videos.

Rewrite the narration below so it is ready to be read aloud and used as the
source for slice cues. Follow every rule:

- Keep the author's meaning, facts, examples, and order. Add nothing, and remove
  no idea. Keep the length close to the original.
- Fix grammar, punctuation, and awkward phrasing. Prefer short, concrete
  sentences of roughly 10–25 words, one idea each.
- Remove accidental repetition: no phrase of four or more words should appear
  twice. A deliberate refrain may stay, but vary the words around each
  occurrence so every occurrence can be quoted as a unique cue.
- Remove filler ("basically", "you know", "kind of") and false starts.
- Write numbers, units, and abbreviations the way they should be spoken.
- Keep the paragraph breaks.
- Output ONLY the rewritten narration. No title, notes, comments, quotation
  marks around the whole text, or markdown fences.`;

export function buildPolishPrompt(script: string) {
  return `${POLISH_INSTRUCTIONS}

SCRIPT TO POLISH:
<<<
${script.trim()}
>>>`;
}

/** Strips the wrappers a model adds even when told not to. */
export function cleanPolishedScript(raw: string) {
  let text = raw.trim();
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = fenced[1]!.trim();
  return text.replace(/\n{3,}/g, "\n\n");
}

/** Reads the text out of a generateContent response. */
export function readGeminiText(payload: unknown): string {
  const root = payload as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
    promptFeedback?: { blockReason?: string };
  } | null;
  const blocked = root?.promptFeedback?.blockReason;
  if (blocked) {
    throw new Error(`Gemini blocked the request (${blocked}). Rephrase and try again.`);
  }
  const parts = root?.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    // Thinking models can return their reasoning alongside the answer.
    .filter((part) => !part?.thought)
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();
  if (!text) throw new Error("Gemini returned no text. Try again, or use another model.");
  return text;
}

function geminiError(status: number) {
  if (status === 400) return "Gemini rejected the request. Try again in a moment.";
  if (status === 401 || status === 403) {
    return "Gemini rejected the key. Rotate VITE_GEMINI_API_KEY and redeploy.";
  }
  if (status === 404) return `The Gemini model "${GEMINI_MODEL}" is not available.`;
  if (status === 429) {
    return "Gemini's free daily limit is used up. Try again later, or polish the script by hand.";
  }
  if (status >= 500) return "Gemini is unavailable right now. Try again shortly.";
  return `Gemini request failed (HTTP ${status}).`;
}

export async function generateGeminiText(prompt: string, signal?: AbortSignal): Promise<string> {
  const key = geminiKey();
  let response: Response;
  try {
    response = await fetch(`${ENDPOINT}/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        // Gemini 3 dropped the sampling parameters; sending one makes the
        // request invalid. The default thinking level is the right trade here.
        generationConfig: { maxOutputTokens: 8192 },
      }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error("Could not reach Gemini. Check your connection and try again.");
  }

  if (!response.ok) throw new Error(geminiError(response.status));
  return readGeminiText(await response.json());
}

/** Polishes the script and returns only the narration, ready to be spoken. */
export async function polishScript(script: string, signal?: AbortSignal): Promise<string> {
  const trimmed = script.trim();
  if (!trimmed) throw new Error("Paste a script first.");
  const text = await generateGeminiText(buildPolishPrompt(trimmed), signal);
  return cleanPolishedScript(text);
}
