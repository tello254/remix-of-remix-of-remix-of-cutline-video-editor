/**
 * Narration transcription settings.
 *
 * There is exactly one Cutline ASR worker, so its address is part of the app
 * rather than a setting. Only the spoken language is a choice, and it lives in
 * localStorage because it is a device preference, not part of the project.
 */

export type AsrConfig = {
  language: string;
};

export const DEFAULT_ASR_ENDPOINT = "https://cutline-asr.cutline-asr.workers.dev";

export type AsrLanguage = {
  value: string;
  label: string;
  flag: string;
};

/** Whisper accepts these language codes; the flag makes the choice scannable. */
export const ASR_LANGUAGES: readonly AsrLanguage[] = [
  { value: "en", label: "English", flag: "🇬🇧" },
  { value: "es", label: "Spanish", flag: "🇪🇸" },
  { value: "fr", label: "French", flag: "🇫🇷" },
  { value: "de", label: "German", flag: "🇩🇪" },
  { value: "pt", label: "Portuguese", flag: "🇵🇹" },
  { value: "it", label: "Italian", flag: "🇮🇹" },
  { value: "nl", label: "Dutch", flag: "🇳🇱" },
  { value: "hi", label: "Hindi", flag: "🇮🇳" },
  { value: "ar", label: "Arabic", flag: "🇸🇦" },
  { value: "zh", label: "Chinese", flag: "🇨🇳" },
  { value: "ja", label: "Japanese", flag: "🇯🇵" },
  { value: "ko", label: "Korean", flag: "🇰🇷" },
  { value: "ru", label: "Russian", flag: "🇷🇺" },
  { value: "tr", label: "Turkish", flag: "🇹🇷" },
  { value: "id", label: "Indonesian", flag: "🇮🇩" },
];

const STORAGE_KEY = "cutline.asr";

export const DEFAULT_ASR_CONFIG: AsrConfig = {
  language: "en",
};

export function loadAsrConfig(): AsrConfig {
  if (typeof window === "undefined") return DEFAULT_ASR_CONFIG;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ASR_CONFIG;
    const parsed = JSON.parse(raw) as Partial<AsrConfig>;
    return {
      language:
        typeof parsed.language === "string" && parsed.language.trim()
          ? parsed.language
          : DEFAULT_ASR_CONFIG.language,
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
