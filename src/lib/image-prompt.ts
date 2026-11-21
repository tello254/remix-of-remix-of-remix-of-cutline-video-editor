/**
 * The image prompt Cutline hands to an image model.
 *
 * The master prompt is deliberately kept here, in the app, rather than in a
 * help page: the builder fills in the script and the style decisions so the
 * text that leaves Cutline is already complete. `docs/master-prompt.md` is the
 * human-readable copy of the same rules.
 *
 * Nothing here talks to a network. `buildImagePrompt` is a pure function, and
 * the prompt text is static apart from the fields the user fills in.
 */

export type ImagePromptFields = {
  /** Free text so "6" and "one per beat" are both valid answers. */
  imageCount: string;
  aspect: string;
};

export type ImagePromptInput = ImagePromptFields & { script: string };

/**
 * One shared reference folder and one drawing style for every project. Keeping
 * these fixed is deliberate: results should not drift between users.
 */
export const REFERENCE_URL = "https://www.dropbox.com/home/HUMANIMATION/humanimation";

export const STYLE_RULES =
  "plain uncoloured background; black ink line art; flat bold outlines; no colour fills; short plain labels";

export const DEFAULT_PROMPT_FIELDS: ImagePromptFields = {
  imageCount: "",
  aspect: "16:9",
};

const STORAGE_KEY = "cutline.imagePrompt";

export const MASTER_PROMPT_TEMPLATE = `## ROLE

You are a storyboard artist, instructional illustrator, and the author of
Cutline slice maps. You explain an idea with pictures that a viewer can follow
with the sound off — no captions, no voiceover. A hand will paint the picture
one numbered slice at a time, in your order.

## INPUTS

- **SCRIPT** — the final narration, at the end of this message. Treat it as
  final: quote it exactly, never rewrite it.
- **REFERENCE IMAGES** — ${REFERENCE_URL}. Match their drawing language.
- **IMAGE SET** — {{IMAGE_SET}}.

If the script is missing, ask for it and stop. Do not invent narration.

## PART 1 — DRAW THE IMAGES

**Story first.** Split the script into visual beats in spoken order. Each image
is one scene or idea-cluster; each **slice** is one distinct idea inside it. The
sequence of slices across all images must retell the script in order. The first
slice of an image begins that part of the story; its last slice hands off to the
next image.

**Make the picture self-explanatory.** Use a consistent visual grammar:

- arrows and motion lines (cause → effect, input → output);
- numbered steps, brackets, and before/after panels;
- magnifier callouts for small details;
- one recurring motif for a recurring idea;
- short labels (1–3 words), never paragraphs.

A sign — an arrow, a label, an icon — is **an idea of its own**. If the
narration names it, give it its own slice. Otherwise it lives inside the slice
it explains. When one slice refers to another, draw the connector inside the
slice that owns it and aim it at a matching numbered marker in the referenced
slice; repeat that marker there. The viewer must be able to connect the two
without audio.

**Position slices so the eye can travel.** Reading order (left → right,
top → bottom) should match narrative order within an image. Size signals
importance. Keep a visible gutter between slices and never overlap them.

**Draw for the crop, not just the page.** A slice border is the crop the hand
paints, so every drawing must sit **fully inside one border**, with breathing
room. If an object is genuinely shared by two ideas, draw it in both slices
rather than straddling the border. Empty space inside a slice is harmless; a cut
object is not.

**Density: the six-second rule.** Design so no slice needs more than about six
seconds of narration — roughly 15 spoken words. If a beat runs longer, split it
into more slices instead of making one slice busier. This is a drawing rule, not
a timing field: never write seconds, durations, or start times anywhere.

**Style.** Follow the reference images exactly: ${STYLE_RULES}. Add simple
geometric icons, generous white space, no gradients, and no clutter.

## PART 2 — WRITE THE SLICE MAP

After the images, output **one** JSON code block in this shape:

~~~json
{
  "schema": "cutline.slice-map/1",
  "images": [
    {
      "file": "scene-01.png",
      "scene": "one line describing this image",
      "slices": [
        {
          "order": 1,
          "cue": "exact words from the script",
          "points": [[0.04, 0.06], [0.44, 0.06], [0.44, 0.50], [0.24, 0.54], [0.04, 0.50]]
        }
      ]
    }
  ]
}
~~~

### Cue rules

- A cue is **3–8 words copied verbatim from the SCRIPT** — contiguous words, in
  the order spoken. Punctuation may be dropped.
- It is a lookup key, not a timestamp. The same script will be read aloud later
  and transcribed, so use words that survive being spoken plainly.
- Within one image, cues must appear in the script in slice order. If a phrase
  repeats in the script, add the neighbouring words this occurrence needs to be
  unique.
- Never take a cue from outside the script. Never write start, duration,
  seconds, or frames.

### Geometry rules

- Coordinates are normalised to the image: [x, y], origin top-left, x right,
  y down, each value 0–1 with 3 decimals.
- **At least 5 points per slice**; use 6–12 for anything that is not a
  rectangle.
- A simple closed polygon: no crossing edges, no zero-length edges, no repeated
  points.
- Stay inside 0.02–0.98 on both axes.
- Slices must not overlap. Leave a 2–4 % gutter between neighbours.
- Together the slices should cover the drawing (about 95–100 % of the canvas).
- Design on a 12 × 12 grid and place coordinates on cell edges. Loose borders
  with padding are good; tight borders that clip a line are not.
- Every image gets its own slices list with order running 1..N in narrative
  order. Images appear in play order.

### Final check — do this before answering

1. Every image has a map, and images are in the order they should play.
2. Every cue appears verbatim in the script and in the right order.
3. Every slice has at least 5 points, is simple, and stays inside 0–1.
4. No two slices overlap; the union covers the drawing.
5. Nothing important crosses a border; labels are short and inside their slice.
6. No timing, duration, or timestamp fields anywhere.

## OUTPUT ORDER

1. A short list: file name → one line describing the image.
2. The images themselves, file names matching the JSON.
3. The single JSON code block.
4. The six-point check, each marked pass/fail.

## SCRIPT

{{SCRIPT}}
`;

function fill(token: string, value: string, text: string) {
  // A replacer function keeps "$&" and friends in the user's text literal.
  return text.replace(token, () => value);
}

function oneLine(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Assembles the final prompt. The script is required: an image prompt without
 * narration would let the model invent the story.
 */
export function buildImagePrompt(input: ImagePromptInput): string {
  const script = input.script.trim();
  if (!script) throw new Error("Paste a script first.");

  const count = oneLine(input.imageCount);
  const aspect = oneLine(input.aspect) || "16:9";
  const imageSet = [
    count ? (count.toLowerCase().includes("image") ? count : `${count} images`) : "as many images as the script needs",
    `${aspect} aspect ratio`,
    "high resolution",
  ].join(" · ");

  let prompt = fill("{{IMAGE_SET}}", imageSet, MASTER_PROMPT_TEMPLATE);
  prompt = fill("{{SCRIPT}}", script, prompt);
  return prompt;
}

export function loadPromptFields(): ImagePromptFields {
  if (typeof window === "undefined") return DEFAULT_PROMPT_FIELDS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PROMPT_FIELDS;
    const parsed = JSON.parse(raw) as Partial<ImagePromptFields>;
    return {
      imageCount: typeof parsed.imageCount === "string" ? parsed.imageCount : "",
      aspect: typeof parsed.aspect === "string" ? parsed.aspect : DEFAULT_PROMPT_FIELDS.aspect,
    };
  } catch {
    return DEFAULT_PROMPT_FIELDS;
  }
}

export function savePromptFields(fields: ImagePromptFields) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fields));
  } catch {
    // A full or blocked storage only costs the user some retyping.
  }
}
