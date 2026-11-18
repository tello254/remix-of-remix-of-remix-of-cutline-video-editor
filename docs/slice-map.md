# Slice maps

A slice map is the border-only description of how an image should be cut and
painted. It is what lets an image arrive already sliced: an external tool — or a
language model — writes the geometry, Cutline validates it and turns it into the
same `SliceShape[]` the hand-drawn slicer produces.

**A slice map never contains time.** No `startSeconds`, no durations, no frames.
When a reveal happens is decided by the narration: the cue is matched against a
transcript, and the timing solver derives start, lag, animation and hold from
that. Timing fields in a map are ignored rather than obeyed, so a model cannot
invent a schedule that looks authoritative.

## Getting one into the editor

Open the slicer on an image, expand **Slice map**, paste the JSON and press
**Import map**. The right-hand list, the numbering on the image, the timeline
bands and undo all behave exactly as if you had drawn those polygons by hand.

**Copy current** writes the slices on the open image back out in this same
format. Use it to reuse a layout on a second image with the same composition, or
to hand a working example to a model.

Import is **all or nothing**. If any slice fails validation, the report lists the
problems with the JSON path that caused them (`$[1].points[2]`) and the image
keeps its existing slices. Nothing is clamped into shape, because a silently
moved border paints the wrong part of the picture.

## Schema

```jsonc
{
  "schema": "cutline.slice-map/1",
  "slices": [
    {
      "order": 1,                          // optional, 1-based play position
      "cue": "most teams start with a mess", // optional, words from the script
      "points": [[0.03, 0.08], [0.30, 0.08], [0.30, 0.92], [0.03, 0.92]]
    }
  ]
}
```

Only one key is required per slice: `points`. Everything below is a convenience.

### Accepted containers

The parser takes any of these, so it can read a hand-written file or a scene from
a larger bundle without preprocessing:

| Shape | Meaning |
| --- | --- |
| `[ … ]` | a bare list of slices |
| `{ "slices": [ … ] }` | the exported form |
| `{ "beats": [ … ] }` | a bundle scene's beats |
| `{ "scene": { "beats": [ … ] } }` | one scene |
| `{ "scenes": [ … ] }` | the first scene that has slices or beats |

### Points

Each point is either `[x, y]` or `{ "x": number, "y": number }`.

By default coordinates are **normalised to 0–1** of the image, so a map survives
any resize. Pixel coordinates are accepted only when explicitly declared:

```jsonc
{
  "space": "pixels",
  "width": 1920,
  "height": 1080,
  "points": [[58, 86], [576, 86], [576, 994], [58, 994]]
}
```

`space`, `width` and `height` may sit on the slice or inside a nested `slice`
object; a caller can also pass defaults. Pixels without a size are rejected — a
bare `960` is meaningless without knowing the image is 1920 wide.

### order

Animation order, not spatial order. Slice 1 is the first thing the hand paints,
which is why it is the first thing the viewer sees; it has nothing to do with
reading order on the page. Duplicate orders are moved to the next free position
and reported as a warning, not an error.

Missing `order` falls back to array position.

### cue

The words that should start this reveal, copied verbatim from the script. It is
free text and is matched against the transcript when you press **Sync**.

`trigger` and `phrase` are accepted as aliases so older output still imports.

## Validation

Errors reject the whole map:

- fewer than three corners;
- a point outside 0–1 (or outside the declared pixel size);
- a border that crosses itself;
- a polygon with no measurable area;
- pixel coordinates without `width`/`height`;
- malformed JSON, or no slice list at all.

Warnings import anyway:

- two slices covering the same pixels;
- slices covering less than half the image, which leaves part of it never drawn;
- a duplicate `order` that had to be moved;
- a repeated point, which is dropped;
- a cue longer than 120 characters, which is hard to match against speech.

Coverage and overlap are measured on a 64×36 grid over the image, so they are
estimates meant to catch a map that is obviously wrong — not exact geometry.

## Example

Two panels side by side, in reading order, with cues from a script:

```json
{
  "schema": "cutline.slice-map/1",
  "slices": [
    {
      "order": 1,
      "cue": "most teams start with a messy problem",
      "points": [[0.03, 0.08], [0.30, 0.08], [0.30, 0.92], [0.03, 0.92]]
    },
    {
      "order": 2,
      "cue": "then the idea arrives",
      "points": [[0.36, 0.08], [0.62, 0.08], [0.62, 0.92], [0.36, 0.92]]
    }
  ]
}
```

Coverage here is about 45%, so importing it warns that the rest of the image is
never painted. That is usually a mistake in the map, not in the warning.

## Code

- `src/lib/slice-map.ts` — `parseSliceMap`, `serializeSliceMap`,
  `SLICE_MAP_SCHEMA`.
- `src/test/slice-map.test.ts` — geometry, container, pixel-space and
  round-trip tests.
- `src/components/slice-editor.tsx` — the paste box and report.
- `src/routes/index.tsx` — `importSliceMap`, which writes through
  `applyClipSlices`.
