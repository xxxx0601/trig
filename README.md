# TailorRig Project Page

Minimal local project page for:

> TailorRig: Controllable and Structured Auxiliary Skeleton Generation for Garment-Aware Rigging

The page is adapted from the [Nerfies project page](https://github.com/nerfies/nerfies.github.io) and keeps the original template attribution in the footer.

## Local preview

No build step or package installation is required.

From this folder, run:

```bash
python3 -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000).

The standalone full-screen workflow is available at
[http://localhost:8000/workflow.html](http://localhost:8000/workflow.html).

## Full-screen workflow

**Play** beside **Debug layout** runs a scripted recording take: Template 01 → 05
→ 11 → Next, Skirt → Hair → Sleeve → Next, Skinning → Next. A macOS-style SVG
cursor follows eased paths, scrolls choices into view, and shows subtle click
feedback. The take waits for bone reveals, the model spin, and camera transitions.
The recording profile keeps cursor actions and pauses short while retaining the
original 2.2-second spin for readability. This adds 1.3 seconds to the earlier fast
profile's timing budget. Resource preparation and Stage 4 are counted separately.
Play caps each bone reveal sequence at 0.45 seconds; manual operation retains the
original reveal speed. Both modes use the same 2.2-second spin.
Actual wall time depends on rendering and model setup. `DEMO_TIMING` centralizes
cursor, opening, scrolling, and scene animation durations.
Required models are decoded before the take; initial preparation may take a moment.
The toolbar and layout tools disappear during playback. The final animation keeps
playing with a clean frame until **Esc** restores manual controls and the previous
debug visibility. Esc also cancels playback; switching away from the window or
resizing it ends the take. Each Play starts again with selections cleared, retaining
the configured camera and panel layouts. Timing and sequence live in
`static/js/workflow-demo.js` (`DEMO_SCRIPT`). This plays the HTML demo; record the
browser with your preferred screen recorder to create a video.

`workflow.html` presents the four TailorRig stages in one persistent Three.js
viewport. Template changes keep the current camera and lighting, stages 2 and 3
load the rig without starting its embedded animation, and stage 4 plays the
selected animation GLB.

Clicking **Next** in Stage 2 spins the current character and its bone overlay
360° around the vertical axis in 2.2 seconds before entering Stage 3. The camera
stays fixed during the spin, and the character returns to its original orientation.

Stages 1–3 render only the character and its bone/weight visualization on the
light background (`#f3f5f8`, matching the main page viewer). Stage 4 shows the `optimized-map/near-512` map.
The map is still loaded at startup to calculate consistent world placement.
The initial view uses
the first exported camera (`CineCameraActor0`) with the workflow's 32° field of
view. Without a saved layout, characters start about 12 map units in front of that camera, remain
upright, and are placed on `floor.glb` with a downward raycast and their initial
bounding-box minimum. This MVP placement is not animated foot IK or collision
handling; exact scale, composition, and foot contact can be refined later.
The map floor receives character shadows, replacing the old shadow plane.

The workflow automatically reads the optional `source/workflow/workflow-layout.json`
on every page load, with caching disabled for that request. When present, its
placements override the calculated defaults; when absent, those defaults remain.
Invalid or unreadable JSON falls back to defaults with a console warning and a
message in the debug panel. The `main` entry is shared by the main character in
all four stages; Stage 4 companions have independent entries.

Click **Debug layout** (or open `workflow.html?debug=1`) to select loaded character
or map assets and edit world position, XYZ rotation in degrees, and scale.
Character placement uses the initial feet-center pivot, with scale applied after
asset normalization. WASD moves the selected object on the horizontal plane
relative to the view, Q/E moves down/up, left/right arrows turn it, and −/+ scales
it. **Control camera** returns keyboard movement to the camera. **Hide debug**
hides the editor while keeping the edited placements applied.

In Debug layout, **Hide selected** hides the selected model and switches to
**Show selected** to restore it. Hidden models remain selectable in the object
list with a **Hidden** label. The main character's bone overlay hides with it.
Visibility overrides persist across stage changes and closing Debug layout for
the current page session; they are not exported to layout JSON and reset on reload.

Edits stay in memory across stage changes. **Export JSON** downloads all stages'
placements, both camera views, and all three independent panel layouts; replace `source/workflow/workflow-layout.json` with that export and
refresh to make it the project default. **Import JSON** applies a file temporarily
without modifying project files. **Reset selected** restores that object's
placement from the initial page load. No backend or automatic file writes are used.

Stages 1, 2, and 3 each have an independent movable, resizable controls panel
layout. **Move**, **Reset panel**, and the resize handle appear only while
**Debug layout** is open; saved layouts also apply outside debug mode.
Switching stages restores that stage's position and size.
Drag **Move** at the top to reposition it, or drag its bottom-right
corner to change width and height. Both handles also accept arrow keys (hold
Shift for 10-pixel steps). **Reset panel** restores only the current stage's responsive default layout.
The choice list scrolls when the panel is shortened. Custom panels stay within
the viewport, with a minimum size of 140 × 160 CSS pixels where space permits.
Stage 4 retains its compact debug controls; returning restores the selected stage's panel.
Stage 2's options and Stage 3's Skinning option show only their titles, with
slightly larger text; internal group keys and the weight visualization subtitle are omitted.

The viewport's camera menu selects any of the four exported poses, keeping the
current lens (32° by default) and character placement unchanged. Left-drag rotates, right-drag pans,
and the wheel zooms. With the viewport focused, W/S move forward/back along the
view direction, A/D move left/right, Q/E move down/up, and Shift moves faster.
`Reset view` restores the selected exported pose. Camera edits live only in
memory until exported. Stages 1–3 share one camera, and Stage 4 has an independent
camera, including its lens and selected preset. Adjust the camera in any of
Stages 1–3, enter Stage 4 and adjust its camera, then export once to save both.
After reload, Stages 1–3 use their saved view. Once Stage 4's assets are ready,
the camera moves to its saved view over 1.8 seconds with smooth acceleration and
deceleration. Orbit and keyboard camera controls pause during the move; exporting
mid-transition still saves the destination. Returning to Stage 3 immediately
restores the shared view. Importing a file also restores the active group's view
immediately, cancelling any transition.

Layout JSON version 4 stores `panels.stage1`, `panels.stage2`, and `panels.stage3`
independently. Each has `position: [x, y]` for the top-left
corner relative to the workflow viewport, and `size: [width, height]` is its size.
All four values are viewport fractions (0–1), so saved layouts adapt to window
size. For example, `{"position": [0.7, 0.05], "size": [0.25, 0.8]}` places the
panel at 70% from the left and 5% from the top, with 25% width and 80% height.
Import restores all three layouts; `null` selects a stage's responsive default.
Exporting from any stage, including Stage 4, saves all three layouts.
Version 3's shared `panels.stage1_3` initializes separate copies for all three stages;
subsequent edits affect only the current stage. Version 1/2 files use responsive defaults.
The supplied version 2 project file remains supported and gains panel parameters
on its next export. Panel data is validated before any imported changes apply.

Layout JSON stores `cameras.stage1_3` and `cameras.stage4`. Each contains:
`position`, `target`, and `up` are three-component world-space vectors;
`target` and `up` determine orientation for OrbitControls. `fov` is the vertical
field of view in degrees, `zoom` is the lens zoom, and `near`/`far` are clipping
distances. `presetIndex` is the zero-based camera menu selection used by
**Reset view**. Version 1 files remain supported: their single `camera` initializes
both groups independently, or camera 1 is used for both if no camera was saved.
The viewport aspect ratio continues to follow the browser size. Import validates
both objects and camera before applying changes, and clears camera drag inertia
when restoring a view. The map files are never modified.

`static/js/workflow-map.js` contains the placement distance and map loading
logic, reusing `optimized-map/load-map.js` and its Meshopt/KTX2 decoders. Serve
the **page directory**, as above: `optimized-map/serve.py` serves only the
standalone map preview. Keep the local `optimized-map` folder available; it is
currently Git-ignored and must be included separately if publishing the page.

Stage 1 starts with no template selected and displays only the first template's
mesh. Selecting a template shows its skeleton; clicking it again clears the
selection and hides the skeleton while keeping the current mesh. Stage 1 renders
every template joint as a Body bone. Stage 2 uses the same
case-insensitive semantic keywords as the main viewer (`skirt`, `hair`,
`sleeve`, `cape`, and `accessory`); it does not infer auxiliary chains from
generic bone names or hierarchy.

Both viewers look for an optional annotation file beside each GLB with the same
basename (for example, `514_WD.glb` uses `514_WD.json`). When present, each
bone is matched exactly by `original_name` and keyword classification runs on
its `display_name`. If the JSON is absent, invalid, or does not contain a bone,
that bone falls back to its original GLB name.

- Template models (FBX): `source/workflow/templates/`
- Auxiliary-bone and skinning model: `source/workflow/stage2_3/514_WD.glb`
- Animation showcase: `source/workflow/stage4/514_WD.glb` starts first, followed
  sequentially by the models in `source/workflow/stage4/others/`.

Update the `TEMPLATES`, `RIG_URL`, and `ANIMATIONS` constants at the top of
`static/js/workflow.js` when the final pipeline uses one continuous mesh.

## Current scope

- Text-focused MVP
- Paper metadata and author list
- Paper, Appendix, Code, Data, and Model link placeholders plus an in-page Video link
- Six interactive GLB previews in a desktop 3 × 2 grid
- Six animated results above Animation Comparison, in two rows of three on desktop
- Mesh, semantic skeleton groups, and full-body weight-color modes
- Texture-free homepage GLBs and Mesh, skeleton, and Weights controls
- A character switcher showing one five-method animation comparison row at a time, with a placeholder for the missing Fox/MIA output
- Immediate animation-card placeholders with loading spinners, followed by viewport-aware GLB loading, two-file concurrency, and WebGL cleanup
- Bounding-box camera fitting that accounts for the viewer aspect ratio
- Crease-aware normal smoothing and shadow-bias correction for split-normal GLB exports
- Abstract
- Placeholder BibTeX
- Official SIGGRAPH Asia logo and an inline local video

## Resource buttons

The six resource buttons are visually active but intentionally do nothing until a URL is provided. To enable one later, edit its `data-url` value in `index.html`:

```html
<button class="... reserved-link" data-url="https://example.com/paper.pdf">Paper</button>
```

Use a section anchor such as `data-url="#video"` when a button should scroll to content on the same page.

## 3D model preview

The page loads `source/model1.glb` through `source/model6.glb` with a custom Three.js viewer. The existing static HTML framework is unchanged and remains compatible with GitHub Pages.

Each card starts in Mesh mode:

- Every model uses the same opaque neutral clay material in the viewer (color `#b8bec8`, metalness `0`, roughness `0.82`).
- Coincident split vertices are smoothed at runtime when their exported normals fall within the crease threshold, which reduces faceted or rippled shading while preserving intentional hard edges.
- The initial camera distance is calculated from all eight bounding-box corners, the camera field of view, and the live canvas aspect ratio so each character starts fully framed.
- Semantic bone buttons are generated from annotation display names when a
  matching sidecar JSON exists, otherwise from the original GLB bone names.
- The viewer supports Mesh, semantic skeleton groups, and Weights. It has no texture mode or `Tex` button.
- Bone-name matching is case-insensitive substring matching.
- Bones that match no semantic keyword are grouped under Body.
- Bone groups are overlaid on the original Mesh as sphere joints and cylinder segments. Each semantic group uses separate fixed colors for joints and bone segments; workflow template previews use the same Body palette.
- Clicking the active bone button again removes the overlay and returns to Mesh only.
- Weights blends each vertex from the stable colors of its influencing bones.

Edit `BONE_KEYWORDS` in `static/js/bone-labels.js` to change the shared semantic
dictionary:

```js
const BONE_KEYWORDS = ["skirt", "hair", "sleeve", "cape", "accessory"];
```

To replace or extend the examples, update the `data-model` paths in `index.html`.

Animation Results loads the six GLBs in `source/anim_results/` above Animation
Comparison. The desktop layout has two rows of three cards, with two columns on
tablets and one on phones. Each card has the same Mesh, semantic skeleton, and
Weights controls as the static results. These six cards form one playback group:
all load before starting together, retain their original speed, and play only the
first seven seconds before restarting together. The `data-playback-limit="7"`
attribute on `#animation-results-grid` caps this group's shared clock; any shorter
clip still ends the loop earlier. The comparison rows retain their existing
shortest-clip loop durations. Both sections share viewport-aware pause/resume
behavior.

Animation cards use the same `RigViewer` implementation as the static cards. The
character tabs and five method columns are defined in `static/js/animation-grid.js`.
Only the selected character's row is displayed, initially Model; inactive rows
cannot load or render. Switching characters immediately pauses the old row,
removes its queued requests, and cancels unfinished model downloads. The five
methods remain in one horizontally scrollable row on narrow screens. Tabs support
arrow keys, Home, and End, and the missing Fox/MIA output has a visible placeholder.

When any method approaches the viewport, the entire selected comparison row loads
with at most two concurrent model requests, including horizontally hidden cards.
Prepared models wait at the beginning until all available methods finish loading.
The row then plays from one shared clock, with every clip retaining its original
speed. Each loop ends at the shortest clip's duration and all methods return to
the beginning together; longer clips' remaining tails are skipped. Hidden cards
join the current shared phase when revealed. The entire row pauses when it leaves
the viewport or the browser tab is hidden. Switching characters resets that row's
clock; returning waits for any evicted models before restarting together. Missing
results do not participate in the wait. Failed loads retain an error message, and
the successful methods start together after all requests finish.

All 31 homepage GLBs (six static models, six animation showcases, and 19 method
comparison results) contain no texture images or texture references. Embedded
image bytes have been removed
from the binary buffers. UV coordinates, tangents, vertex colors, geometry,
skeletons, skinning weights, and animation data are preserved. The initial 25
models and their SHA-256 checksums are backed up under the Git-ignored
`source/bck/models-with-textures-*/`, preserving their paths relative to `source/`.
The six models in `source/anim_results/` were cleaned without creating another
backup, as their originals were already backed up separately.
The standalone workflow assets are outside this cleanup's scope.

### Main-page performance and caching

Models within 140 vertical / 160 horizontal pixels of the viewport can preload,
with two concurrent loads and onscreen cards taking priority. A nearby animation
card also preloads and retains every method in its selected comparison row, so
the synchronization barrier can finish on narrow screens. A separate observer
starts rendering only when the 3D stage actually intersects the viewport.
Leaving the viewport immediately stops rendering. Up to three recently inactive
cards retain their model, camera, and display mode for ten seconds; older cards
are disposed sooner when the cache fills. Hidden browser tabs pause rendering
and defer new queued loads until the tab becomes visible again.

The initial content bounds, including the sampled animation bounds, are saved as
small JSON records in browser `localStorage` under `tailorrig:model-bounds:v1`.
Subsequent visits on the same origin/browser reuse them. The SHA-256 of the
downloaded GLB invalidates a record when the model changes. This cache skips
bounding-box calculations, not the model download or parsing. Up to 64 records
are retained. Blocked or full storage falls back to an in-memory cache, and an
unavailable Web Crypto API falls back to calculating bounds normally.
The cache does not write a JSON/TXT file into the project; clearing site data or
changing the site's origin removes access to the previous browser records.

Each mesh caches its per-bone weight colors at preparation time. Weight geometry
and vertex colors are generated on the first Weights click and reused until the
card is disposed. Runtime normal smoothing, automatic rotation, frame rate,
shadow resolution, and asset files retain their existing behavior.

Run the focused cache, weight, lifecycle, and synchronized playback checks with:

```bash
node tests/viewer.test.mjs
```

## Inline video

The current page plays `source/video/video1.mp4` directly above the Abstract. For another inline video, place an H.264/AAC MP4 file under `source/` and use a native video element:

```html
<section class="section" id="video">
  <div class="container is-max-desktop">
    <video controls playsinline preload="metadata" poster="./source/video-poster.jpg">
      <source src="./source/demo.mp4" type="video/mp4">
      Your browser does not support HTML video.
    </video>
  </div>
</section>
```

The `controls` attribute adds playback controls, `playsinline` keeps playback inside the page on mobile, and `preload="metadata"` avoids downloading the entire video before the user presses play.

## Website license

The original Nerfies website template is licensed under the [Creative Commons Attribution-ShareAlike 4.0 International License](https://creativecommons.org/licenses/by-sa/4.0/).
