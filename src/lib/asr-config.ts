/**
 * Where the editor sends narration audio.
 *
 * This lives in localStorage rather than in the project: the endpoint is a
 * device-level choice, and the optional access token must never end up inside a
 * project file or the undo history.
 */

export type AsrConfig = {
  endpoint: string;
  token: string;
  language: string;
};

export const DEFAULT_ASR_ENDPOINT = "https://cutline-asr.cutline-asr.workers.dev";

const STORAGE_KEY = "cutline.asr";

export const DEFAULT_ASR_CONFIG: AsrConfig = {
  endpoint: DEFAULT_ASR_ENDPOINT,
  token: "",
  language: "en",
};

function cleanEndpoint(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_ASR_ENDPOINT;
  const trimmed = value.trim();
  return trimmed || DEFAULT_ASR_ENDPOINT;
}

export function loadAsrConfig(): AsrConfig {
  if (typeof window === "undefined") return DEFAULT_ASR_CONFIG;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ASR_CONFIG;
    const parsed = JSON.parse(raw) as Partial<AsrConfig>;
    return {
      endpoint: cleanEndpoint(parsed.endpoint),
      token: typeof parsed.token === "string" ? parsed.token : "",
      language: typeof parsed.language === "string" ? parsed.language : "en",
    };
  } catch {
    return DEFAULT_ASR_CONFIG;
  }
}

export function saveAsrConfig(config: AsrConfig) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Private mode or a full quota: transcription still works for this session.
  }
}
