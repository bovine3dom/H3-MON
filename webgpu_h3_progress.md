# WebGPU H3 Progress And Handoff

Last updated: 2026-07-16

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

The compute and rendering paths are now integrated. The CPU-packed renderer
remains the default WebGPU geometry mode and A/B reference; direct GPU geometry
is opt-in with `h3gpu=compute`.

### Live WebGPU overlay

`src/webgpu/packed-h3-renderer.js` is integrated with `src/app.js` behind the
`renderer` query parameter:

| Query value | Behavior |
| --- | --- |
| `renderer=deck` | Existing deck.gl path; currently the default |
| `renderer=webgpu` | Explicit WebGPU overlay; errors are surfaced |
| `renderer=auto` | Attempts WebGPU and falls back to deck.gl |

`h3gpu=packed` uses CPU-packed geometry and remains the default.
`h3gpu=compute` uploads source-order H3 IDs and colors, computes boundaries and
ear-clipped triangles on the renderer's existing GPU device, and renders without
geometry readback.

The packed mode receives geometry produced by `packH3Geometry()`. Direct mode
does not invoke it unless auto mode needs to fall back to deck.gl.

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
- Transactional direct-chunk validation before old chunks are removed.
- Frame-level WebGPU validation, internal-error, and out-of-memory scopes.
- Renderer-generation ownership across initialization, removal, and fallback.

### Direct H3 rendering

`src/webgpu/direct-h3-backend.js` connects `H3ComputeModule` to a GPU
ear-clipping pass and a procedural triangle render pipeline:

- Resolutions 0 through 10 are accepted, including mixed supported resolutions.
- Up to eight triangles and 24 procedural vertices are reserved per source cell.
- Concave boundaries are triangulated rather than rendered as a fixed fan.
- Geometry remains GPU-resident; only a 16-byte aggregate validation record is
  read back before a chunk becomes visible.
- Per-cell world shifting handles antimeridian cells before origin subtraction.
- Duplicate and numerically collinear projected vertices are reduced.
- Direct mode is currently limited to zoom 14 and 500,000 resident cells.
- Unsupported input or a GPU validation failure fails closed in explicit mode
  and switches to deck.gl in auto mode.

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

- H3 resolutions 0 through 10.
- Hexagons and pentagons.
- Pentagon descendant rotation and deleted subsequence validation.
- FaceIJK overage adjustment and face transforms.
- Class III face-crossing vertices.
- Invalid ID, unsupported resolution, topology overflow, transform failure,
  and numeric failure statuses.
- Compensated Cartesian projection intended to avoid the large errors found in
  the first f32 trigonometric implementation.

The compute module can create its own adapter/device or use a caller-owned
device. Direct rendering supplies the packed renderer's existing device.

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

The continuation re-ran `npm run build`, `node --check` for `src/app.js`, the
packed renderer, and the direct backend, and `git diff --check` after the final
changes.

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
re-run exhaustively on a native hardware WebGPU adapter and must still receive
broader hardware coverage before integration.

A forced-WebGPU Firefox 151.0.4 smoke run on the current machine compared 2,032
cells across resolutions 4-8 at tolerance `1e-7`. It included all pentagons,
pentagon neighbors, polar and antimeridian samples, and boundaries with 5, 6,
7, and 10 vertices. It reported zero failures over 12,372 points and maximum
normalized-Mercator error `8.677707064030926e-8`. Firefox did not expose
adapter-identification fields, so this is useful native-machine evidence but
not a substitute for the exhaustive, adapter-identified run.

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

## Current Firefox Machine

The continuation used:

- Firefox 151.0.4 with `dom.webgpu.enabled=true` and
  `gfx.webgpu.force-enabled=true`.
- geckodriver 0.37.0 in headless mode.
- Linux 6.18.35-1-lts.
- NVIDIA GeForce GTX 1080 Ti with NVIDIA driver 570.211.01.

Firefox reported a software compositor and disabled its shared-texture
swapchain because `GBM_FORMAT_ARGB8888` was unavailable. It withheld WebGPU
adapter vendor/device fields, so browser timings remain unsuitable for
production decisions even though compute and moderate renderer workloads ran.

Observed correctness results:

- `renderer=deck` reached `Ready` with `h3_data.csv` and the 29,324-cell
  `h3_data_old_2.csv` fixture.
- `renderer=webgpu` and `renderer=auto` reached `Ready` with the 63-cell and
  29,324-cell fixtures and retained the overlay across viewport chunk changes.
- Deck/WebGPU screenshots for `h3_data_old_2.csv` had normalized RMSE
  `0.00851785` at the default view.
- Explicit WebGPU exhausted Firefox's headless WebGPU memory budget while
  uploading the visible 771,009 cells from `h3_data.csv`; it failed closed and
  removed the overlay.
- `renderer=auto` recovered from that same out-of-memory event, created 135
  deck chunks, waited for the replacement deck frame, and reached `Ready`.
- Chromium 149 with WebGPU disabled reached `Ready` through adapter-absence
  fallback. Chromium headless with WebGPU enabled destroyed its device and
  also failed to produce a replacement WebGL frame, matching the prior
  software/backend limitation.
- `population_density_hilo.arrow` is not present under `www/data/` on this
  checkout, so it was not retested.

### Direct renderer validation

The integrated direct path was tested in forced-WebGPU Firefox after the final
lifecycle, triangulation, and ownership changes:

- A 26-cell fixture covering resolutions 4-8, the concave
  `85006da3fffffff` counterexample, polar cells, and antimeridian cells reached
  `Ready` with no GPU validation failures.
- The 29,324-cell `h3_data_old_2.csv` fixture reached `Ready` and remained ready
  after a viewport change to zoom 10.
- A targeted packed/direct screenshot at the concave-cell view had RMSE `0`.
- A 2,032-cell resolutions 4-8 compute parity sample retained zero failures and
  maximum normalized-Mercator error `8.677707064030926e-8` at tolerance `1e-7`.
- Mixed input whose first row was supported and second row was unsupported
  failed closed explicitly and reached `Ready` through deck in auto mode.
- Zoom 16 failed closed and removed the overlay explicitly; auto mode waited for
  and published a deck frame.
- Boundary parity exhaustively covered all 122 resolution-0, 842 resolution-1,
  5,882 resolution-2, and 41,162 resolution-3 cells. Resolutions 0-2 had no
  `1e-7` failures; three polar resolution-3 points reached a maximum error of
  `1.780360079361998e-7`.
- Direct triangulation passed all 41,162 resolution-3 cells and deterministic
  global/pentagon samples at every resolution 0-10.
- The application reached `Ready` with one mixed chunk containing every
  resolution 0-10. Resolution 11 failed closed explicitly and reached `Ready`
  through deck in auto mode.
- Resolution 11 produced a degenerate final triangle in the direct validation
  sample, with increasingly frequent failures at resolutions 13-15. The public
  range therefore stops at 10 rather than claiming incomplete higher support.

## Known Correctness Issues

These remain after the lifecycle fixes:

- Only three world copies are rendered, regardless of viewport width, and the
  code does not honor `map.getRenderWorldCopies()`.
- Separate `mix-blend-mode: multiply` canvases change composition when deck.gl
  highlight or train layers overlap the WebGPU H3 layer.
- Coarse chunk origins can still lose precision at high zooms, especially for
  resolution-5 data grouped under resolution-0 parents.
- Direct compute emits absolute `f32` Mercator boundaries before origin
  subtraction, so zooms above 14 are deliberately rejected or sent to deck.
- Resolutions 11-15 remain disabled until boundary output becomes origin-relative
  before `f32` rounding and high-resolution triangulation is revalidated.
- Parent-derived chunk bounds use a conservative heuristic rather than bounds
  proven from every member cell; unusual descendants could still be culled.

Resolved in the continuation:

- Renderer ownership is published only after style readiness, Mercator
  validation, custom-layer insertion, and a final ready-state check.
- Initialization, render, layer-removal, device-loss, and fallback paths now
  destroy their renderer, canvas, observer, and GPU resources.
- The complete render preamble and submission are inside one error boundary.
- Render waits support timeout and abort cancellation, pause their timeout
  budget while the document is hidden, and reject on zero-area canvases.
- Deck replacement waits require a real frame and also pause while hidden.
- Chunk additions are staged before removals and rolled back on upload failure;
  dataset-qualified renderer IDs permit staging a replacement dataset before
  releasing the current one.
- Style readiness no longer treats unrelated map-wide errors as style errors.
- WebGL-to-WebGPU clip depth conversion and Mercator-only enforcement are in
  place, including runtime projection changes.

## Performance Work Still Needed

- Retain or cache uploaded chunk buffers instead of recreating them after every
  deactivate/reactivate cycle.
- Write style uniforms only when colors, highlighting, or transition progress
  changed; camera-only frames currently rewrite every chunk's style buffer.
- Avoid calling deck.gl `setProps()` when only WebGPU H3 state changed.
- Measure sample count 1 versus 4 on integrated and discrete hardware.
- Measure compute dispatch, upload bandwidth, render time, memory use, and
  reload latency separately.

## Packaging And Anti-Rot Plan

The WebGPU implementation has a reusable package boundary, but moving all of
`src/webgpu/` into a separate repository immediately would not by itself prevent
rot. Extraction is worthwhile only if the package owns durable tests and H3-MON
continues consuming it as an integration test.

Recommended sequence:

1. Add permanent browser parity, rendering, lifecycle, and fallback tests in
   this repository. Do not extract code that is only covered by ad hoc scripts.
2. Create an internal workspace package without changing runtime behavior.
3. Add TypeScript declarations, capability reporting, package exports, notices,
   and explicit ownership contracts.
4. Make H3-MON consume the workspace package while retaining all application
   policy in `src/app.js`.
5. After the API and tests remain stable, move the package to a separate
   repository and pin H3-MON to released versions or exact commits.

### Proposed package boundary

Generic code suitable for extraction:

- `h3-compute.js` and `h3-compute-wgsl.js`.
- `direct-h3-backend.js`, initially as an internal renderer implementation.
- Generic rendering and resource-lifecycle code from
  `packed-h3-renderer.js`, renamed around H3 rather than packed geometry.
- `h3-compute-parity.js` under a testing-only export.
- `h3-compute-NOTICES.md` and all required license material.

Code that should remain in H3-MON:

- Arrow/row H3 normalization and application data schemas.
- H3 parent grouping, chunk bounds, viewport residency, and hysteresis.
- Quantile/color generation and cartogram integration.
- Deck layer construction and Deck/WebGPU fallback policy.
- Map style ownership, load progress, query parameters, and update generations.

MapLibre integration should be an optional adapter export. Consolidate the
integrated `createMapLibreMatrixLayer()` path with, or remove, the unused
`maplibre-camera-bridge.js` path before publishing both as public APIs.

### Proposed exports

The package should have small explicit entry points rather than exposing every
class, shader, and GPU buffer layout:

```js
import {
    createH3ComputeModule,
    createH3WebGPURenderer,
} from 'h3-webgpu'

import {createMapLibreH3Layer} from 'h3-webgpu/maplibre'
import {runH3ComputeParity} from 'h3-webgpu/testing'
```

The public renderer should expose `addPackedChunk()` and `addH3Chunk()` rather
than retaining the now-incomplete `PackedH3Renderer` name. It should report its
tested envelope directly:

```js
renderer.capabilities
// {
//     h3Version: '4.4.1',
//     minResolution: 0,
//     maxResolution: 10,
//     projection: 'web-mercator',
//     maxTestedZoom: 14
// }
```

Keep these internal initially:

- Raw WGSL strings and binding layouts.
- `DirectH3Backend` and its procedural vertex ABI.
- GPU error-scope helpers.
- Internal color, style-uniform, matrix, and validation-buffer layouts.

Before publishing, explicitly define:

- Canvas, `GPUDevice`, and resource ownership.
- Matrix coordinate and clip-depth conventions.
- Render scheduling and completion semantics.
- Device-loss, chunk-validation, and terminal-error behavior.
- Packed geometry compatibility with `faster-h3-for-deckgl`.
- Separate-canvas composition limitations: no shared depth, terrain occlusion,
  MapLibre style ordering, Deck ordering, globe projection, or picking.
- A neutral package blend-mode default; H3-MON should request `multiply`
  explicitly if it retains the current appearance.

### Maintenance policy

Keep `renderer=deck` as the application default and direct WebGPU explicitly
opt-in. Do not resume resolution 11-15 or performance work until browser support
justifies it. The package should have:

- A deterministic fixture covering resolutions 0-10, pentagons, face crossings,
  poles, the antimeridian, and `85006da3fffffff`.
- A resolution-11 fixture proving explicit failure and Deck fallback.
- Pull-request build, syntax, shader-compilation, and adapter-absence tests.
- A scheduled native-GPU parity and screenshot run on the existing Firefox
  machine; software adapters may check correctness but never performance.
- Exact H3 oracle and `faster-h3-for-deckgl` commit/version pins.
- Full package tests before H3, MapLibre, Deck, or browser-runner upgrades.

Packaging should isolate the reusable renderer from application churn. It is
not a substitute for CI, and a detached package without an active consumer
would rot faster than code kept in this repository.

## Prioritized Todo On The WebGPU Machine

### P0: establish a trustworthy baseline

- [x] Run `npm run build` and `git diff --check` before browser testing.
- [ ] Use a native hardware WebGPU adapter; do not force SwiftShader for
  performance measurements.
- [ ] Confirm `renderer=deck` still loads both test datasets and record baseline
  screenshots and timings.
- [ ] Confirm `renderer=webgpu` loads both datasets without browser flags beyond
  those genuinely required by that browser/platform.
- [x] Re-run `h3-compute-parity.js` against the final shader at tolerance
  `1e-7` on the forced Firefox adapter (representative smoke, not exhaustive).
- [x] Include ordinary, pentagon, face-crossing, antimeridian, and polar cells
  at every supported resolution in that smoke run.
- [ ] Record adapter/browser/driver details with all parity and performance
  results.
- [ ] Compare deck.gl and WebGPU screenshots at zooms 0, 5, 10, 16, and 22,
  with pitch and bearing variations.

### P0: fix renderer lifecycle before compute integration

- [x] Wait for the MapLibre style before allocating the WebGPU renderer.
- [x] Publish `webgpuRenderer` only after the custom layer is added and the
  renderer is still in the ready state.
- [x] Destroy the local or active renderer in every initialization/fallback
  failure path.
- [x] Wrap the entire render preamble and command submission in error handling
  that rejects pending waiters.
- [x] Add a bounded timeout/cancellation path to WebGPU render waits.
- [x] Make chunk selection and reload transactional, with rollback on failed
  uploads.
- [x] Correct clip-depth conversion.
- [x] Restrict or fall back when MapLibre is not using Mercator projection.

### P1: connect compute output to rendering

- [x] Initialize `H3ComputeModule` with the packed renderer's existing device;
  do not request a second device.
- [x] Store lower/upper H3 words per chunk in source-cell order.
- [x] Dispatch the compute shader when a chunk is first uploaded.
- [x] Keep compute output on the GPU; only read aggregate validation status.
- [x] Add a render pipeline that consumes boundary records directly.
- [x] Prove a fixed triangle fan is invalid and
  emit robust triangle indices/vertices from compute instead of assuming it.
- [x] Preserve one source-cell ID per primitive for color lookup.
- [ ] Replace absolute `f32` compute output so direct rendering can safely exceed
  resolution 10 and the current zoom-14 guard.
- [x] Fail closed and fall back if any valid source cell returns a non-success
  compute status.
- [x] Avoid CPU `packH3Geometry()` in direct mode after screenshot parity was
  established; retain it lazily for packed mode and deck fallback.
- [x] Keep the current packed geometry renderer as an A/B reference.

### P1: fallback and composition

- [ ] Test true adapter absence, denied device creation, shader compilation
  failure, upload failure, render failure, and runtime device loss.
- [x] Ensure `renderer=auto` renders a deck.gl frame before resolving load-ready.
- [ ] Decide whether H3, highlights, and train layers should share one overlay
  composition group so multiply blending occurs once.
- [ ] Derive world-copy count from viewport width and MapLibre's world-copy
  setting.

### P2: cleanup after proof

- [ ] Add durable tests and fixtures before extracting the WebGPU package.
- [ ] Create an internal `h3-webgpu` workspace package and make H3-MON consume
  it without changing renderer or fallback behavior.
- [ ] Add package declarations, capabilities, subpath exports, notices, and
  explicit canvas/device ownership contracts.
- [ ] Move the package to a separate repository only after its API and tests are
  stable and H3-MON is a pinned external consumer.
- [ ] Remove `src/webgpu/maplibre-camera-bridge.js` if its unused duplicate
  camera bridge is not selected for consolidation.
- [ ] Remove unused WebGPU highlight state if highlighting remains in deck.gl.
- [ ] Consider dynamic deck.gl loading only after fallback behavior is stable.
- [ ] Consider moving GeoJSON and railway rendering to native MapLibre later;
  this is not required for the H3 compute proof.
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

Direct supported-resolution dataset:

```text
http://127.0.0.1:1983/?data=h3_data_old_2.csv&cartogram=none&renderer=webgpu&h3gpu=compute
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
| `src/webgpu/direct-h3-backend.js` | Direct GPU triangulation, validation, and rendering |
| `src/webgpu/h3-compute-wgsl.js` | Experimental H3 4.4.1 boundary compute kernel |
| `src/webgpu/h3-compute.js` | Compute pipeline, upload, dispatch, readback, and cleanup API |
| `src/webgpu/h3-compute-parity.js` | Browser parity comparison helpers |
| `src/webgpu/h3-compute-NOTICES.md` | luma.gl MIT and H3 Apache-2.0 attribution |
| `src/webgpu/maplibre-camera-bridge.js` | Unused alternative camera bridge; likely removable |
| `node_modules/faster-h3-for-deckgl/dist/pack-h3-geometry.js` | Current authoritative CPU geometry/triangulation reference |
| `esbuild.config.mjs` | Current single-bundle build configuration |

## Worktree Notes

The original WebGPU/chunking proof is tracked in commit `07e989a`. The
continuation modifies `src/app.js`, `src/webgpu/packed-h3-renderer.js`, and this
handoff file, and adds `src/webgpu/direct-h3-backend.js`. No new commit was
created.

The current pre-existing untracked files are unrelated and must not be modified
or removed while continuing this work: `scratch.js`, `scratch/`, `sratch.sql`,
and `style.patch`.

Existing editor/LSP errors for the extensionless local imports
`./vendor/observablehq` and `./cartogram` predate this WebGPU work; the esbuild
build resolves them successfully.
