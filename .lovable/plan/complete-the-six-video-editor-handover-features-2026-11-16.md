# Complete the six video-editor handover features

## Scope
Finish all six items in the existing single-page editor. Keep imported media and editing state local to the browser; do not add accounts, uploads, or persistence.

## Work
1. Replace per-frame smooth timeline scrolling with direct `scrollLeft` synchronization during playback so the playhead tracks without rubber-banding.
2. Render the existing import actions in the top bar and a mobile media drawer. Reuse the local file pickers and library for video, images, and audio.
3. Add file drag-and-drop to the preview and timeline. A preview drop places imported media on a compatible track at the playhead; a timeline drop places it on the targeted compatible track at the cursor time, accounting for scroll and zoom. Register media once, without also creating an unintended appended clip.
4. Connect selected-clip trim handles to the existing `trimClip` model. Populate source duration for imported and recorded clips, show edge feedback while dragging, and commit the final trim once through project history.
5. Add category-aware track menus for adding rows and muting or hiding them. Use categories for track labels and default placement; mute controls audio output, while hide controls visual preview visibility, without removing clips.
6. Render configured transitions in the preview during their time windows: crossfade, wipe, horizontal slide, and fade-to-black, using the existing transition progress calculation and ensuring both transition clips can be previewed during the effect.

## Verification
- Add focused tests for timeline/trim/transition calculations or state rules where pure logic can be isolated; run the existing timeline tests.
- Exercise the import, preview drop, timeline placement, trim, track controls, transition playback, and playback-follow flows in the running editor.
- Check desktop and mobile layouts and review the latest preview build and runtime signals.

## Technical notes
- Keep changes in the current editor page, its styles, and adjacent timeline tests; preserve the single-page client-only media workflow and existing design tokens/components.
