# Remix of Remix of Remix of Cutline Video Editor

Build a standalone CapCut-style timeline editor web application with the following behavior:

1. Layout & Preview:
- Preview window on top and multi-track timeline strip below.
- A global Play/Pause button that plays the full composite timeline across all tracks and cuts at 1x speed.
- The preview strictly shows what the playhead is currently hovering over. If the playhead is over an empty gap with no clip, the preview displays black/blank and audio is muted.
- Multi-track compositing: multiple rows for video/images, multiple rows for voice recording, and multiple rows for audio. Two clips in parallel video/image rows are both visible in the preview (layered compositing).

2. Media Upload & Durations:
- Upload section for video, image, and audio files.
- Accurate video duration: video clips must load metadata to render their true full length on the timeline (e.g. an 8-second video spans an exact 8-second block on the timeline ruler).
- Images/photos default to a 4-second scene block upon insertion.
- Direct voice recording tool using the browser microphone that records straight into an audio track.

3. Timeline strip & Calibration:
- Uniform timeline calibration with Zoom In and Zoom Out controls that adjust the scale (pixels per second).
- Autoscroll during playback: as the video plays at 1x, the timeline strip moves left smoothly to keep the playhead centered and visible in the viewport.
- Smooth magnetic snapping and dragging of clips across tracks and time.

4. Editing Controls & History:
- Split / cut clip at the playhead position.
- Copy, paste, duplicate, and delete options for clips.
- Full Undo and Redo history stack.
- Transitions: when two cuts sit adjacent on the same track, provide an interactive transition button in the middle to choose the transition effect (crossfade, wipe, slide, fade to black) and set its duration.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/09ab97d9-4f9d-4c6f-abde-0a2bd09586a2).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
