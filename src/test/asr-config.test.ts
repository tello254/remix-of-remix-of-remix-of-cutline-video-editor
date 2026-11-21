import { describe, expect, it } from "vitest";

import {
  ASR_LANGUAGES,
  DEFAULT_ASR_CONFIG,
  DEFAULT_ASR_ENDPOINT,
  loadAsrConfig,
  saveAsrConfig,
} from "@/lib/asr-config";

describe("asr config", () => {
  it("falls back to defaults when nothing is stored", () => {
    window.localStorage.clear();
    expect(loadAsrConfig()).toEqual(DEFAULT_ASR_CONFIG);
    expect(DEFAULT_ASR_CONFIG.language).toBe("en");
    expect(DEFAULT_ASR_ENDPOINT).toContain("workers.dev");
  });

  it("keeps only the chosen language", () => {
    saveAsrConfig({ language: "de" });
    expect(loadAsrConfig()).toEqual({ language: "de" });
    expect(window.localStorage.getItem("cutline.asr")).toBe('{"language":"de"}');
  });

  it("ignores a legacy record's endpoint and token", () => {
    window.localStorage.setItem(
      "cutline.asr",
      JSON.stringify({ endpoint: "https://old.workers.dev", token: "abc", language: "fr" }),
    );
    expect(loadAsrConfig()).toEqual({ language: "fr" });
  });

  it("survives corrupt storage", () => {
    window.localStorage.setItem("cutline.asr", "{oops");
    expect(loadAsrConfig()).toEqual(DEFAULT_ASR_CONFIG);

    window.localStorage.setItem("cutline.asr", JSON.stringify({ language: "   " }));
    expect(loadAsrConfig()).toEqual(DEFAULT_ASR_CONFIG);
  });

  it("offers flagged languages with unique codes", () => {
    expect(ASR_LANGUAGES.length).toBeGreaterThan(5);
    expect(new Set(ASR_LANGUAGES.map((language) => language.value)).size).toBe(
      ASR_LANGUAGES.length,
    );
    expect(ASR_LANGUAGES.find((language) => language.value === "en")?.flag).toBe("🇬🇧");
  });
});
