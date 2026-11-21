import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GEMINI_MODEL,
  buildPolishPrompt,
  cleanPolishedScript,
  generateGeminiText,
  polishScript,
  readGeminiText,
} from "@/lib/gemini";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("gemini", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_GEMINI_API_KEY", "test-key");
  });

  it("sends the shared key, fixed model and prompt, then returns the text", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: "Hello there." }] } }] }),
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    const text = await generateGeminiText("Say hello");

    expect(text).toBe("Hello there.");
    const calls = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    const [url, init] = calls[0]!;
    expect(url).toContain(`/models/${GEMINI_MODEL}:generateContent`);
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBeTruthy();
    expect(String(init.body)).toContain("Say hello");
  });

  it("turns a used-up free tier into a human sentence", async () => {    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 429)) as unknown as typeof fetch,
    );

    await expect(generateGeminiText("x")).rejects.toThrow(/daily limit/i);
  });

  it("polishes through the model and strips a code fence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          candidates: [{ content: { parts: [{ text: "```text\nA cleaner script.\n```" }] } }],
        }),
      ) as unknown as typeof fetch,
    );

    await expect(polishScript("raw words")).resolves.toBe("A cleaner script.");
  });

  it("explains a blocked request instead of returning empty text", () => {
    expect(() => readGeminiText({ promptFeedback: { blockReason: "SAFETY" } })).toThrow(/blocked/i);
    expect(() => readGeminiText({ candidates: [] })).toThrow(/no text/i);
  });

  it("keeps thinking out of the polished script", () => {
    const payload = {
      candidates: [
        {
          content: {
            parts: [
              { text: "internal reasoning", thought: true },
              { text: "The polished words." },
            ],
          },
        },
      ],
    };
    expect(readGeminiText(payload)).toBe("The polished words.");
  });

  it("quotes the script inside the polish instructions", () => {
    expect(buildPolishPrompt("keep this line")).toContain("keep this line");
    expect(buildPolishPrompt("keep this line")).toContain("no phrase of four or more words");
  });

  it("normalises the model's formatting", () => {
    expect(cleanPolishedScript("  One.\n\n\n\nTwo.  ")).toBe("One.\n\nTwo.");
  });

  it("names the missing setting instead of sending an empty key", async () => {
    vi.stubEnv("VITE_GEMINI_API_KEY", "");
    await expect(generateGeminiText("x")).rejects.toThrow(/VITE_GEMINI_API_KEY/);
  });
});
