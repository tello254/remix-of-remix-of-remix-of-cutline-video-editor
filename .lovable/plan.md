# Timeline rows: one add-row control, labels locked to their rows

## What changes
1. **Remove the "+ Video / + Image / + Voice / + Music" buttons** under the row labels.
2. **The three-dot menu at the start of each row becomes the place to add rows.** Its "Add row" item opens a short list — Video, Image, Voice, Music — and the new row is placed right after the row whose menu you opened (or at the right spot within its type group). Remove row, Mute and Hide stay in the same menu.
3. **Each row's label (icon, name, type, three dots) is attached to its row.** Scrolling up or down moves the label and the row together, so they can never drift apart. Scrolling sideways keeps the label pinned at the far left while the clips slide underneath.

## Technical details
- Drop the separate `track-rail` scroll column and the two-way scrollTop syncing in `src/routes/index.tsx`.
- Render each row as one flex line inside the single `timeline-scroll` container: a `position: sticky; left: 0` label cell (146px, rail background, z-index above clips) followed by the lane. The ruler gets a matching sticky top-left corner cell showing the timecode.
- Adjust clip/playhead/ruler click math so the 146px label offset is subtracted from pointer positions.
- Track menu: replace the single "Add {type} row" item with a `DropdownMenuSub` listing the four categories, each calling `addTrack(category, track.id)`.
- Remove `.add-track-row` styles; existing timeline tests should keep passing (run them).
