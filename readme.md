# H3-MON

A MapLibre GL and deck.gl viewer for H3 data in CSV, Arrow and Parquet, with linked
geographic and cartogram views. GeoJSON support is experimental.

## Run Locally

Prerequisites: Node.js, Yarn, Git and a WebGL-capable browser. Dependencies include
Deno for the local server. Installation and the server's first run need network access.

1. Clone this repository and run `yarn install` in its root.
2. Put your dataset at `www/data/example.csv` (or `.arrow` / `.parquet`).
3. Run `yarn build`, then `yarn serve`.
4. Open `http://localhost:1983/?data=example.csv&cartogram=none`.

Run `yarn watch` in another terminal to rebuild source changes; the server watches data files.
HTTP uses port 1983; the development file-watcher WebSocket uses port 1990.
For static deployment, serve the built `www/` directory, including the Parquet
WASM asset copied there during installation.

## Data Format

CSV needs a header row. Arrow and Parquet use named columns with the same schema:

| Column | Type | Purpose |
|--------|------|---------|
| `index` | string | Hexadecimal H3 cell ID. |
| `index_lower`, `index_upper` | uint32 | Alternative to `index`: low and high 32-bit words of the H3 ID. |
| `value` | number | Value to colour and display. |
| `weight` | number, optional | Weights for value scaling and aggregation. |
| Other columns | optional | Additional tooltip data. |

Use either string H3 IDs or both unsigned split columns, not floating-point H3
IDs. CSV, Arrow and Parquet data can feed both views; cartogram mappings are Arrow.
For Arrow reader compatibility, use uncompressed IPC and non-dictionary-encoded
string columns. Query endpoints return complete Arrow IPC files or streams.

The `data` parameter selects a file under `www/data/`; omitting its extension
selects CSV. For `example.arrow`, optional metadata lives at `www/data/example.json`.

## Metadata And Settings

URL settings override metadata, which overrides built-in defaults. The cog opens
Settings; valid edits apply automatically. **Reset** restores metadata defaults.
Shared URLs store nondefault settings,
raw request-control inputs and the map-position hash, preserving unrelated parameters.

Initial loads show detailed progress. Reloads keep the current map usable with a
delayed corner spinner. Failed requests retain the previous result and offer
**Retry** and expandable error details.

```json
{
  "t": "Example measurements",
  "c": "Example data provider",
  "cartogram": "none",
  "colourScheme": "interpolateViridis",
  "colourScale": "quantile"
}
```

| Key | Values / Meaning |
|-----|------------------|
| `t` | Browser and legend title. |
| `c` | Comma-separated additional attribution names. |
| `colourScheme` | D3 interpolator name, such as `interpolateViridis`. |
| `cyclical` | Use Rainbow rather than Spectral when no explicit scheme is set. |
| `flip` | Reverse colours. |
| `colourScale` | `quantile` (default), `rankit`, `linear` or `raw`. |
| `trimFactor` | Fraction from 0 to less than 0.5; default 0.01. |
| `quantileSource` | Visible `map` (default) or `cartogram` values used for scaling. |
| `legendBounds` | Fixed linear bounds as JSON `[min,max]`; `null` unfreezes. |
| `scale` | JSON object mapping numeric breakpoints to legend labels, or `null`. |
| `trains` | Show OpenRailwayMap maximum-speed tiles. |
| `crosshair` | Show the centre crosshair when `onmove` is enabled; default true. |
| `cartogram` | Mapping filename, blank/default for `cartogram_weights.arrow`, or `none`. |
| `defaultValue` | Numeric fallback for missing cartogram contributors, or `null`. |
| `infill` | Allow the fallback to fill wholly unobserved cartogram cells. |
| `requireCompleteCoverage` | Leave cells missing if any positive-weight contributor is missing. |

`quantile` distributes colours by rank; `rankit` gives tails more colour space.
`linear` uses percentile endpoints selected by `trimFactor` (0 uses min/max).
`raw` expects values already in 0..1. Legends retain original units.
**Freeze legend** captures the displayed numeric endpoints as a fixed linear scale
for both panes, overriding the selected mode, trim and quantile source until
unfrozen. Out-of-range values use endpoint colours; equal bounds use the midpoint.

Scale labels use a raw JSON textarea: `{"0":"Low","1":"High"}`, or `null` for automatic labels.

### Legacy Flags

Legacy `raw`, `linear` and `rankit` booleans remain supported in metadata and URLs:

| Priority | Colour mode selection |
|----------|-----------------------|
| 1 | A valid URL `colourScale` wins. |
| 2 | Any legacy URL flag, even `raw=false`, selects merged metadata/URL flags with priority `raw > linear > rankit > quantile`. |
| 3 | Otherwise, a valid metadata `colourScale` wins. |
| 4 | Otherwise, metadata flags use the same legacy priority. |

Invalid `colourScale` values are ignored. Changing the selector writes
`colourScale` and removes legacy URL flags; unrelated edits preserve them.
Boolean URL parameters are enabled when bare or with most values; `0`, `false`,
`off` and `no` disable them, ignoring case and surrounding whitespace. Settings
writes changed booleans as `1` or `0`; metadata is not rewritten.

## Interaction Endpoints

Metadata can define `onclick` and `onmove` hooks. Each requires an HTTP(S) `url`
template; relative URLs resolve against the page. By default the viewer makes GET
requests returning Arrow. An optional absolute `socket` selects the
[query WebSocket protocol](docs/query-websocket.md). No query backend is bundled.

```json
{
  "t": "Measurements near {TOWN_NAME}",
  "cartogram": "none",
  "controls": {
    "threshold": {
      "label": "Threshold", "type": "number", "default": 10,
      "min": 0, "max": 100, "step": 1
    }
  },
  "onclick": {
    "url": "https://example.org/data?index={index}&threshold={controls.threshold}",
    "resolution": 5, "focus": false, "highlight": true
  },
  "onmove": {
    "url": "https://example.org/data?index={index}&threshold={controls.threshold}",
    "resolution": 5
  }
}
```

`onclick` uses the clicked geographic cell, including cells absent from the result;
cartogram clicks use a central linked H3 cell. `focus` and `highlight` independently
control camera focus and selection, both defaulting to true. `onmove` uses the
geographic map centre during user pan/zoom, not pointer hover or programmatic moves.
Optional `resolution` is 0..15, defaulting to the dataset's H3 resolution.
Optional `wait` is 0..60000 milliseconds (HTTP default 350, WebSocket default 0);
positive values schedule movement requests with a trailing latest position.

Templates accept `{index}`, `{index_lower}`, `{index_upper}`, `{lat}`, `{lng}`,
`{zoom}` and `{controls.<id>}`; substituted URL values are URL-encoded.
Titles accept the same tokens plus `{TOWN_NAME}`, the nearest city from
tiny-geocoder, not an administrative boundary. Titles and selection follow the
successfully displayed result; pending or failed queries retain the previous state.
Unknown or unavailable title tokens stay unchanged.

Missing, null or false hooks are disabled; `onclick=false` / `onmove=false` in the
URL disables automatic delivery without preventing saved-query replay.
Use HTTPS endpoints on HTTPS pages and configure CORS for cross-origin HTTP requests.

## Request Controls And Shared Links

`controls` is keyed by IDs starting with a letter and containing letters, digits
or underscores. Each field requires `label`, `type` and `default`. Types are
`number`, `time`, `text`, `select` and `boolean`; optional `unit` and `help` describe
the field. Numbers and times accept `min`, `max` and native input `step`.
Selects require `options`, for example `[{"value":"mean","label":"Mean"}]`.

An optional `encode` is a JavaScript function expression string, for example
`"(value, values) => value * 1000"`, receiving the typed input and all raw values;
it returns a string, finite number or boolean synchronously. Metadata is trusted
JavaScript. Invalid inputs or failed conversions do not send requests.
Valid control edits rerun the last origin, or the map centre before the first query.

Shared links keep raw inputs as `p.<id>` and the query origin/event/zoom as `query`
JSON, not response data. Replay uses the metadata endpoint and preserves the saved
camera. Recipients need access to the dataset metadata and endpoint. Titles use raw
control values (select labels), not encoded values; shared links retain the template.

## Cartogram Mapping

A mapping joins H3 cells to square grid cells using weighted means. Select its Arrow filename with `cartogram`.

| Column | Type / Purpose |
|--------|----------------|
| `x`, `y` | Integer grid coordinates; x increases right, y downward. |
| `index` or `index_lower` + `index_upper` | String H3 ID or unsigned 32-bit halves. |
| `weight_mean` | Preferred numeric aggregation weight when present. |
| `weight` | Fallback when `weight_mean` is absent; unit weights if both are absent. |
| `code` | Optional numeric subdivision code for borders. |
| `label` | Optional cell label. |

Mappings allow many-to-many contributions; normalize weights per `(x,y)` cell.
Split-index datasets select the mapping's `_hilo.arrow` variant.
Fine H3 data is rolled up; coarse data is projected to mapping resolution.
`requireCompleteCoverage` also requires every expected fine-resolution child,
including absent rows, and overrides `defaultValue` and `infill`; zero-weight
missing contributors do not invalidate a cell.

## Tests

Run `yarn test` for unit tests and `yarn test:rendering` for the headless browser
suite. The latter needs Playwright Chromium installed (`yarn playwright install chromium`),
or `CHROMIUM_PATH` pointing to a Chromium executable. Tests use generated fixtures,
not local datasets or live query endpoints.

## License And Attribution

Code is [BSD-2-Clause](LICENSE), copyright Oliver Blanthorn. Data and tiles retain
their own licenses. Keep provider attribution when publishing a view; metadata `c`
adds credits rather than replacing the standard ones. The viewer credits OpenFreeMap,
Natural Earth, openwaters.io et al., Mapterhorn, OpenStreetMap contributors,
Our World in Data and GeoNames.
