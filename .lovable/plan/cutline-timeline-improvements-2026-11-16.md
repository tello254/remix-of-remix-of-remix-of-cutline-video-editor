# Cutline Timeline Improvements

## Goal
Complete the requested six editor improvements while keeping the workspace single-page and all media local in the browser.

## Implementation
- Replace playback-triggered smooth scrolling with direct `scrollLeft` synchronization.
- Add persistent header import controls and a mobile media-library drawer, reusing the existing file inputs and local object-URL workflow.
- Support file drops on the preview and timeline; timeline drops compute time from the pointer and target a compatible row.
- Add selected-clip trim handles. Video/audio trims adjust timeline bounds and source offsets within the original media duration; images can extend without a source limit.
- Initialize categorized Videos, Images, Voice Over, and Background Music rows. Allow compatible rows to be added from each row’s menu and let users mute audio rows or hide visual rows.
- Render configured transitions in the canvas during their cut window: crossfade, wipe, slide, and fade-to-black.
- Add focused timeline helper tests for trim bounds and transition progress, then run the existing timeline tests and verify the editor preview.

## Technical details
Keep changes in the existing `/` editor, timeline helper module, tests, and editor styles. Extend local clip/track state only; do not add uploads, accounts, persistence, or export rendering.
