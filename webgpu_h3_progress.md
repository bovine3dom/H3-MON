# WebGPU H3 Progress And Handoff

Last updated: 2026-07-15

## Goal

Replace the CPU-heavy H3 boundary packing and deck.gl H3 rendering path with a
transparent WebGPU overlay while retaining deck.gl as a safe fallback.

The intended end state is:

- H3 IDs and colors are uploaded to WebGPU.
- A compute shader converts H3 IDs to boundary vertices.
- A render pipeline draws those boundaries without CPU geometry readback.
- MapLibre supplies the camera matrix and remains responsible for the basemap.
- `renderer=auto` falls back to deck.gl if initialization or rendering fails.

## Current Status

The proof of concept has two separate pieces. They are not connected yet.

### Live WebGPU overlay

`src/webgpu/packed-h3-renderer.js` is integrated with `src/app.js` behind the
`renderer` query parameter:

| Query value | Behavior |
| --- | --- |
| `renderer=deck` | Existing deck.gl path; currently the default |
| `renderer=webgpu` | Explicit WebGPU overlay; errors are surfaced |
| `renderer=auto` | Attempts WebGPU and falls back to deck.gl |

The live WebGPU renderer currently receives geometry produced by the CPU
`packH3Geometry()` function. It proves camera alignment, color transitions,
chunk activation, transparent composition, world copies, and buffer handling,
but it does **not** yet remove the expensive H3 CPU packing step.

Implemented renderer features:

- Separate transparent, pointer-transparent WebGPU canvas above MapLibre.
- MapLibre custom-layer bridge using `modelViewProjectionMatrix`.
- Per-chunk vertex, index, color, style, and matrix GPU buffers.
- Per-cell RGBA colors without expanding colors over every vertex.
- Interrupted cubic color transitions.
- Chunk-relative Mercator positions.
- Antimeridian handling and basic world copies.
- Four-sample MSAA.
- Render completion promises, resource destruction, and device-loss handling.
- WebGPU absence is non-fatal in `renderer=auto`.

### H3 compute kernel

The following standalone files implement H3 ID-to-boundary compute work:

- `src/webgpu/h3-compute-wgsl.js`
- `src/webgpu/h3-compute.js`
- `src/webgpu/h3-compute-parity.js`
- `src/webgpu/h3-compute-NOTICES.md`

The API accepts little-endian lower/upper `u32` H3 ID words and emits one
88-byte record per cell:

- Ten `vec2<f32>` normalized Web Mercator boundary slots.
- A boundary vertex count.
- An explicit status code.
- NaN-filled unused or failed slots.

Implemented compute coverage:

- H3 resolutions 4 through 8.
- Hexagons and pentagons.
- Pentagon descendant rotation and deleted subsequence validation.
- FaceIJK overage adjustment and face transforms.
- Class III face-crossing vertices.
- Invalid ID, unsupported resolution, topology overflow, transform failure,
  and numeric failure statuses.
- Compensated Cartesian projection intended to avoid the large errors found in
  the first f32 trigonometric implementation.

The compute module can create its own adapter/device or use a caller-owned
device. Supplying the renderer's device is the likely integration route.

## Existing H3 Chunking

`src/app.js` now groups rows by an H3 parent and keeps only viewport-adjacent
chunks resident:

- `h3chunkres=off` disables chunking.
- `h3chunkres=0`, `1`, or `2` selects an explicit parent resolution.
- Automatic mode starts at `dataResolution - 5`.
- Automatic grouping reduces the parent resolution to stay at or below 512
  chunks where possible.
- Selection uses padded map bounds and retention hysteresis.
- Color refresh and viewport quantile sampling understand chunks.
- String and split-word H3 inputs are supported.

Chunked deck.gl output was previously tested as pixel-identical to the
unchunked path, including antimeridian views and viewport recoloring.

## Validation So Far

### Build and syntax

- `npm run build` passes.
- `node --check` passes for the standalone compute JavaScript modules.
- `git diff --check` passes.

### Packed WebGPU renderer

The packed renderer loaded and drew both test datasets through Chromium/Dawn
using software Vulkan:

- `h3_data.csv`
- `population_density_hilo.arrow`

Observed software-renderer timings for the larger dataset included:

| Measurement | Time |
| --- | ---: |
| CPU H3 geometry packing | 3147.5 ms |
| WebGPU renderer initialization | 4632.5 ms |
| Load to map ready | 5475.9 ms |
| Chunk selection | 58.2 ms, then 116.8 ms |

These are SwiftShader results and must not be treated as hardware performance.

Four-sample MSAA improved screenshot similarity against deck.gl from an RMSE
of `0.0441058` to `0.0220914`. Remaining differences were concentrated around
polygon edges.

### Compute kernel

An independent smoke run caught a large error in the first compute projection:
`6.49e-5` normalized Mercator on a 6,600-cell representative sample. The
projection was subsequently replaced with compensated Cartesian math.

The post-fix software-Vulkan parity run reported:

| Coverage | Cells | Maximum normalized-Mercator error |
| --- | ---: | ---: |
| Resolution 4, exhaustive | 288,122 | `8.3930e-8` |
| Resolution 5, exhaustive | 2,016,842 | `9.2471e-8` |
| Resolutions 6-8, stratified | 300,401 | `9.1249e-8` |
| Dedicated polar sample | not recorded | `7.0031e-8` |

The run reported no status, topology, boundary-count, unused-slot, or `1e-7`
tolerance failures. This final shader revision has not been independently
re-run on a native hardware WebGPU adapter and must be validated there before
integration.

Even `1e-7` normalized-world error can become visible at extreme zooms. At
zoom 22 it is roughly 215 world pixels before matrix/perspective effects.
Direct rendering therefore still needs chunk-relative or high/low coordinate
handling; compute parity alone is not sufficient proof of screen-space parity.

## Laptop Limitation

This laptop did not provide a trustworthy native WebGPU test environment.

The working browser invocation forced Vulkan through SwiftShader:

```sh
chromium \
  --headless \
  --no-sandbox \
  --enable-unsafe-webgpu \
  --enable-unsafe-swiftshader \
  --enable-features=Vulkan \
  --use-angle=vulkan \
  --use-vulkan=swiftshader \
  --window-size=1280,800 \
  'http://127.0.0.1:1983/?data=h3_data.csv&cartogram=none&renderer=webgpu&perf=1'
```

A basic SwiftShader configuration destroyed the shared GPU device and also
invalidated MapLibre/deck.gl's WebGL context. That failure is likely an artifact
of this software setup rather than representative fallback behavior.

Do not use this laptop's timings or device-loss behavior to make production
decisions.

## Known Correctness Issues

These were identified in review and remain to be fixed:

- Device loss during asynchronous initialization can publish a renderer that
  has already entered the lost state.
- Fallback removes the matrix layer but does not always destroy the failed
  renderer, canvas, observer, and buffers.
- `waitForRender()` can remain unresolved when the canvas has zero area or an
  error occurs before command submission.
- The application has no timeout around the WebGPU render waiter.
- Chunk activation and data reload are not transactional; a failed upload can
  leave renderer resources and application bookkeeping inconsistent.
- `waitForMapStyle()` rejects on any map-wide error, including unrelated tile
  or source errors.
- The vertex shader currently forces midpoint depth instead of converting the
  WebGL clip depth with `0.5 * (clip.z + clip.w)`.
- Only three world copies are rendered, regardless of viewport width, and the
  code does not honor `map.getRenderWorldCopies()`.
- Mercator-only operation is documented but not enforced.
- Separate `mix-blend-mode: multiply` canvases change composition when deck.gl
  highlight or train layers overlap the WebGPU H3 layer.
- Fallback completion does not wait for the first replacement deck.gl frame.
- Coarse chunk origins can still lose precision at high zooms, especially for
  resolution-5 data grouped under resolution-0 parents.

## Performance Work Still Needed

- Avoid calling `packH3Geometry()` for every chunk in the WebGPU path.
- Avoid packing chunks that have never entered the padded viewport.
- Retain or cache uploaded chunk buffers instead of recreating them after every
  deactivate/reactivate cycle.
- Write style uniforms only when colors, highlighting, or transition progress
  changed; camera-only frames currently rewrite every chunk's style buffer.
- Avoid calling deck.gl `setProps()` when only WebGPU H3 state changed.
- Measure sample count 1 versus 4 on integrated and discrete hardware.
- Measure compute dispatch, upload bandwidth, render time, memory use, and
  reload latency separately.

## Prioritized Todo On The WebGPU Machine

### P0: establish a trustworthy baseline

- [ ] Run `npm run build` and `git diff --check` before browser testing.
- [ ] Use a native hardware WebGPU adapter; do not force SwiftShader for
  performance measurements.
- [ ] Confirm `renderer=deck` still loads both test datasets and record baseline
  screenshots and timings.
- [ ] Confirm `renderer=webgpu` loads both datasets without browser flags beyond
  those genuinely required by that browser/platform.
- [ ] Re-run `h3-compute-parity.js` against the final shader at tolerance
  `1e-7` on the native adapter.
- [ ] Include ordinary, pentagon, face-crossing, antimeridian, and polar cells
  at every supported resolution.
- [ ] Record adapter/browser/driver details with all parity and performance
  results.
- [ ] Compare deck.gl and WebGPU screenshots at zooms 0, 5, 10, 16, and 22,
  with pitch and bearing variations.

### P0: fix renderer lifecycle before compute integration

- [ ] Wait for the MapLibre style before allocating the WebGPU renderer.
- [ ] Publish `webgpuRenderer` only after the custom layer is added and the
  renderer is still in the ready state.
- [ ] Destroy the local or active renderer in every initialization/fallback
  failure path.
- [ ] Wrap the entire render preamble and command submission in error handling
  that rejects pending waiters.
- [ ] Add a bounded timeout/cancellation path to WebGPU render waits.
- [ ] Make chunk selection and reload transactional, with rollback on failed
  uploads.
- [ ] Correct clip-depth conversion.
- [ ] Restrict or fall back when MapLibre is not using Mercator projection.

### P1: connect compute output to rendering

- [ ] Initialize `H3ComputeModule` with the packed renderer's existing device;
  do not request a second device.
- [ ] Store lower/upper H3 words per chunk in source-cell order.
- [ ] Dispatch the compute shader when a chunk is first uploaded.
- [ ] Keep compute output on the GPU; do not add a production readback.
- [ ] Add a render pipeline that consumes boundary records directly.
- [ ] Prove a fixed triangle fan is valid for every emitted H3 boundary, or
  emit robust triangle indices/vertices from compute instead of assuming it.
- [ ] Preserve one source-cell ID per primitive for color lookup.
- [ ] Make compute output chunk-relative or use high/low coordinate components
  so absolute f32 Mercator values do not fail at high zoom.
- [ ] Fail closed and fall back if any valid source cell returns a non-success
  compute status.
- [ ] Remove CPU `packH3Geometry()` only after direct-GPU screenshot parity is
  established.
- [ ] Keep the current packed geometry renderer temporarily as an A/B reference
  while integrating direct GPU boundaries.

### P1: fallback and composition

- [ ] Test true adapter absence, denied device creation, shader compilation
  failure, upload failure, render failure, and runtime device loss.
- [ ] Ensure `renderer=auto` renders a deck.gl frame before resolving load-ready.
- [ ] Decide whether H3, highlights, and train layers should share one overlay
  composition group so multiply blending occurs once.
- [ ] Derive world-copy count from viewport width and MapLibre's world-copy
  setting.

### P2: cleanup after proof

- [ ] Remove `src/webgpu/maplibre-camera-bridge.js` if its unused duplicate
  camera bridge is not selected for consolidation.
- [ ] Remove unused WebGPU highlight state if highlighting remains in deck.gl.
- [ ] Consider dynamic deck.gl loading only after fallback behavior is stable.
- [ ] Consider moving GeoJSON and railway rendering to native MapLibre later;
  this is not required for the H3 compute proof.
- [ ] Add durable browser parity and lifecycle tests rather than keeping only
  ad hoc DevTools scripts.
- [ ] Document supported H3 resolutions, projections, precision limits, and
  fallback behavior for users.

## Suggested Test URLs

Start the existing server with:

```sh
npm run serve
```

Small dataset:

```text
http://127.0.0.1:1983/?data=h3_data.csv&cartogram=none&renderer=webgpu&perf=1
```

Large dataset:

```text
http://127.0.0.1:1983/?data=population_density_hilo.arrow&cartogram=none&renderer=webgpu&perf=1
```

For every scenario, repeat with `renderer=deck` and `renderer=auto`.

## Relevant Files

| File | Purpose |
| --- | --- |
| `src/app.js` | Renderer selection, H3 chunking, colors, lifecycle, and fallback integration |
| `src/webgpu/packed-h3-renderer.js` | Currently integrated CPU-packed WebGPU renderer |
| `src/webgpu/h3-compute-wgsl.js` | Experimental H3 4.4.1 boundary compute kernel |
| `src/webgpu/h3-compute.js` | Compute pipeline, upload, dispatch, readback, and cleanup API |
| `src/webgpu/h3-compute-parity.js` | Browser parity comparison helpers |
| `src/webgpu/h3-compute-NOTICES.md` | luma.gl MIT and H3 Apache-2.0 attribution |
| `src/webgpu/maplibre-camera-bridge.js` | Unused alternative camera bridge; likely removable |
| `node_modules/faster-h3-for-deckgl/dist/pack-h3-geometry.js` | Current authoritative CPU geometry/triangulation reference |
| `esbuild.config.mjs` | Current single-bundle build configuration |

## Worktree Notes

No commit was created. At handoff time, the WebGPU/chunking work consists of a
modified `src/app.js` and untracked files under `src/webgpu/`, plus this handoff
file.

The following pre-existing untracked files are unrelated and must not be
modified or removed while continuing this work:

- `bun.lock`
- `ecdf.patch`
- `h3_layer_optimisation_plan.md`
- `stable_colour.patch`

Existing editor/LSP errors for the extensionless local imports
`./vendor/observablehq` and `./cartogram` predate this WebGPU work; the esbuild
build resolves them successfully.
