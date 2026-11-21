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
format — including the image number, file name, slice numbers and trigger
phrases. Use it to reuse a layout on a second image with the same composition,
to hand a working example to a model, or as a snapshot of slicing you did by
hand.

Import is **all or nothing**. If any slice fails validation, the report lists the
problems with the JSON path that caused them (`$[1].points[2]`) and the image
keeps its existing slices. Nothing is clamped into shape, because a silently
moved border paints the wrong part of the picture.

### A map is a first draft

Geometry authored away from the picture is only a guess at where a drawing
really is, so an imported border is not locked. After a successful import the
slicer switches to **Select** and every slice shows draggable handles:

| Action | Result |
| --- | --- |
| drag a handle | moves that one corner |
| drag inside the slice | moves the whole border, unchanged in shape |
| double-click an edge | inserts a corner at the midpoint of that edge |

Dragging is how you pull a border over a drawing that overflows it: the picture
stays visible behind the outline while you work. A drag that would fold the
border over itself or flatten it to nothing is refused — the handle turns red
and the last good border stays put. One drag is one undo step, committed when
the pointer is released.

Every slice has at least **five** corners, hand-drawn or imported. A map that
describes a box or a triangle is accepted and topped up to five by inserting
points on its longest edges. A point inserted on a straight edge covers the same
pixels, so the shape does not change — only the number of places you can grab
it. The report says how many points were added.

## Schema

```jsonc
{
  "schema": "cutline.slice-map/1",
  "space": "normalized",
  "images": [
    {
      "image": 4,                          // optional, play position on the timeline
      "file": "scene-04.png",              // optional, used to pick this image from a bundle
      "scene": "one line describing it",   // optional
      "slices": [
        {
          "number": 1,                     // permanent label, separate from play order
          "order": 1,                      // 1-based play position
          "cue": "most teams start with a mess", // optional, words from the script
          "points": [[0.03, 0.08], [0.30, 0.08], [0.30, 0.92], [0.03, 0.92]]
        }
      ]
    }
  ]
}
```

**Copy current** writes exactly this: the image's number and file name, then every
slice with its number, play order, trigger phrase and border coordinates. Paste
it back into the same image and nothing is lost — slice numbers included — which
is what makes the manual workflow reversible. A bare `{ "slices": [ … ] }` is
still accepted, so older maps keep working.

### Accepted containers

The parser takes any of these, so it can read a hand-written file or a scene from
a larger bundle without preprocessing:

| Shape | Meaning |
| --- | --- |
| `[ … ]` | a bare list of slices |
| `{ "slices": [ … ] }` | the minimal object form |
| `{ "images": [ { "file", "slices": [ … ] } ] }` | the exported form, and the one the master prompt asks a model to write |
| `{ "beats": [ … ] }` | a bundle scene's beats |
| `{ "scene": { "beats": [ … ] } }` | one scene |
| `{ "scenes": [ … ] }` | the first scene that has slices or beats |

When a bundle describes several images, Cutline imports the entry whose `file`
(or `name`) matches the image that is open. If none matches, the first image is
used and the report says how many images the map contained.

### number

The slice's permanent label, as shown in the slicer. It is **not** the play
order: moving a slice changes `order` and leaves `number` alone, so an exported
map reloads with the same names. Missing numbers fall back to the array
position; a duplicate is reported and that slice takes the list position.

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

A cue is a **lookup key, not a timestamp**. When several slices repeat the same
words, each sync takes the next occurrence after the previous slice, so a
repeated phrase cannot drag two reveals onto the same second.

## From cue to seconds

Press **Sync** (the mic button next to the slices) and Cutline does the rest.
Two things happen, in this order:

1. **Script to transcript.** The narration script you pasted is aligned to the
   Whisper transcript once for the whole scene. The script decides the wording,
   the transcript only says when each word was heard. This is why rambling or a
   misheard word cannot scatter a boundary: the boundary set comes from the
   script, so the number of beats stays right even when the speech wanders.
2. **Cue to beat.** Each cue is given the beat that owns it.

Without a script, each cue is searched for directly in the transcript. A cue
that occurs exactly once is simply used. A cue that repeats is disambiguated by
borrowing a *neighbouring* phrase that occurs only once, within 1.5 s and inside
the same clause — in this fixed order:

| Step | Borrowed phrase | Direction |
| --- | --- | --- |
| 1 | the next two words | forward |
| 2 | the next single word | forward |
| 3 | the previous two words | backward |
| 4 | the previous single word | backward |

The first candidate that does not start before the previous reveal has ended
wins. If nothing qualifies, the slice is pushed to that end and flagged **pushed
later** — never silently moved.

### Scene length

The image grows to its narration. A picture the engine can draw in 9 seconds
keeps its 9-second drawing time, but the scene itself lasts as long as the voice
under it: a cue spoken at 20 seconds is revealed at 20 seconds, not squeezed
into the first 9. Growth stops at whatever comes next — the next clip on the row,
or the end of the voice — so a scene can never swallow its neighbour.

Within that longer scene a reveal keeps the engine's natural paint time (about
1.2 s; see `SLICER_PAINT_TICKS`). Everything left over between one reveal's end
and the next reveal's start becomes **hold**, which is why a long narration makes
pictures rest on screen instead of drawing slowly. Scenes are never shrunk
automatically: dragging a boundary or trimming the clip still means what it says.

### Estimation

A cue that was written but never heard is still placed, because the slice was
meant to be there. Cutline fits it between its neighbours using the narration's
own beats and marks it **estimated** — a blue `≈` badge, never counted as timed.

- The window is `[end of the previous reveal, next slice's start − this
  drawing]`. An estimate never intrudes on the previous drawing and never
  pushes its own into the next one.
- The beat is taken from the narration itself: a word that follows a pause of
  at least 120 ms can start a slice. Among the beats in the last second of the
  window, the strongest wins, latest on a tie — a full stop beats a comma or a
  long pause (250 ms), which beats a short one.
- The start is the chosen beat when it fits in the window; otherwise it is as
  late as the window allows, so the drawing finishes exactly as the next slice
  starts. If that would leave the previous slice holding for more than half its
  own drawing time, the slice is centred in the gap instead — the pause is dead
  air, and spreading it looks calmer.
- If the gap is smaller than the drawing, the reveal is shortened (never below
  0.25 s) and starts at the previous reveal's end; the resolver flags it
  **tight**.
- The last slice treats the end of the clip as its boundary.
- Several missing cues in a row share one gap: it is split evenly, and each
  drawing is centred in its share.
- A slice with **no cue at all** is not estimated — there is no way to know
  where it belongs. It is reported as **without a cue**.
- A beat that exists before the picture, or past the room the scene is allowed,
  belongs to another scene. It is reported as **could not be placed** rather
  than stretched into this one.

Estimation is stored on the slice, so the badge survives re-solving. Editing the
cue or dragging a boundary clears it: from then on the timing is the user's, not
a guess.

The report says *why* a slice was estimated: **not in the script** when the cue's
words never appear in the script at all, **not spoken** when the script contains
them but the recording does not.

### What the badges mean

| Badge | Meaning |
| --- | --- |
| yellow `!` | the schedule had to give: pushed later, tight, or running early |
| blue `≈` | placed by rule between its neighbours, not by its own words |
| purple band | the start was moved by hand; that is visible, so it gets no badge |

## Validation

Errors reject the whole map:

- fewer than three corners;
- a point outside 0–1 (or outside the declared pixel size);
- a polygon with no measurable area;
- pixel coordinates without `width`/`height`;
- malformed JSON, or no slice list at all.

A three- or four-corner border is valid, but is topped up to the five-point
minimum described above.

Warnings import anyway:

- points were added to reach the five-point minimum;
- the border's edges cross themselves, so it paints with a gap — a freehand
  stroke can double back, and the handles are there to untangle it;
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
- `src/lib/slice-geometry.ts` — the five-point minimum and the drag rules
  (`ensureMinimumPoints`, `translatePoints`, `movePoint`).
- `src/test/slice-map.test.ts` — geometry, container, pixel-space and
  round-trip tests.
- `src/test/slice-geometry.test.ts` — top-up, translation, corner-drag and
  refusal tests.
- `src/components/slice-editor.tsx` — the paste box, report and border handles.
- `src/routes/index.tsx` — `importSliceMap`, which writes through
  `applyClipSlices`.
