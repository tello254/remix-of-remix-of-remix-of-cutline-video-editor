import { describe, expect, it } from "vitest";

import { DEFAULT_PROMPT_FIELDS, buildImagePrompt } from "@/lib/image-prompt";

const base = {
  ...DEFAULT_PROMPT_FIELDS,
  script: "First we plant a seed.\n\nThen it grows.",
};

describe("buildImagePrompt", () => {
  it("puts the final script inside the master prompt", () => {
    const prompt = buildImagePrompt(base);

    expect(prompt).toContain("Cutline slice maps");
    expect(prompt).toContain("six-second rule");
    expect(prompt).toContain("At least 5 points per slice");
    expect(prompt).toContain("## SCRIPT\n\nFirst we plant a seed.\n\nThen it grows.");
    // The paragraph break survives, so the cue rules can talk about order.
    expect(prompt.split("First we plant a seed.")).toHaveLength(2);
  });

  it("fills the image count and aspect and leaves no template token", () => {
    const prompt = buildImagePrompt({ ...base, imageCount: "4", aspect: "4:3" });

    expect(prompt).not.toContain("{{");
    expect(prompt).toContain("4 images · 4:3 aspect ratio · high resolution");
  });

  it("always carries the shared reference folder and fixed style", () => {
    const prompt = buildImagePrompt(base);

    expect(prompt).toContain("https://www.dropbox.com/home/HUMANIMATION/humanimation");
    expect(prompt).toContain("black ink line art");
    expect(prompt).toContain("as many images as the script needs · 16:9 aspect ratio");
  });

  it("will not build without a script", () => {
    expect(() => buildImagePrompt({ ...base, script: "   \n  " })).toThrow(/script/i);
  });

  it("keeps dollar signs in the script literal", () => {
    const prompt = buildImagePrompt({ ...base, script: "It costs $& and $1." });
    expect(prompt).toContain("It costs $& and $1.");
  });
});
