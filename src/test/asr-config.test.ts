import { describe, expect, it } from "vitest";

import {
  DEFAULT_ASR_CONFIG,
  DEFAULT_ASR_ENDPOINT,
  loadAsrConfig,
  saveAsrConfig,
} from "@/lib/asr-config";

describe("asr config", () => {
  it("falls back to defaults when nothing is stored", () => {
    window.localStorage.clear();
    expect(loadAsrConfig()).toEqual(DEFAULT_ASR_CONFIG);
    expect(DEFAULT_ASR_CONFIG.endpoint).toBe(DEFAULT_ASR_ENDPOINT);
  });

  it("round-trips the worker URL, token and language", () => {
    const config = { endpoint: "https://example.workers.dev", token: "abc", language: "de" };
    saveAsrConfig(config);
    expect(loadAsrConfig()).toEqual(config);
  });

  it("survives a corrupt record and an empty endpoint", () => {
    window.localStorage.setItem("cutline.asr", "{oops");
    expect(loadAsrConfig()).toEqual(DEFAULT_ASR_CONFIG);

    window.localStorage.setItem("cutline.asr", JSON.stringify({ endpoint: "   ", token: 5 }));
    expect(loadAsrConfig()).toEqual({ ...DEFAULT_ASR_CONFIG, endpoint: DEFAULT_ASR_ENDPOINT });
  });
});
