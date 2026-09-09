# H3-MON: THE MOST POWERFUL MON(itor) IN THE UNIVERSE

A simple data vis tool using MapLibre GL and deck.gl to display and refresh H3
data from CSV, Arrow and Parquet files. GeoJSON and cartogram support is
experimental.

<p align="center"> <img src="promo/demo.png" alt="An astonishingly beautiful
map of the UK"> </p>

## How to run

You'll need Node.js, Yarn, Git, a web browser with WebGL and some data with [H3
indices](https://h3geo.org/).

0. `git clone`
1. `yarn install`
2. bung data in `./www/data/h3_data.{csv, arrow, parquet}` with index (hex strings), values and optionally weights
3. `yarn serve&; yarn watch`, open `localhost:1983/?data=h3_data{,.csv, .arrow, .parquet}`
4. data will be refreshed with a file watcher

## data format

| column | type | description |
|--------|------|----------|
| `index` or `index_lower` + `index_upper` | H3 hex string or unsigned 32-bit halves | the 32-bit halves are faster so use them unless you really can't manage it |
| `value` | number | your data |
| `weight` | number, optional | weight for scaling and aggregation |
| other stuff | optional | gets bunged in the tooltip |

Arrow files can be stream (IPC) or random access (...file. yeah they really do
call them arrow file files.) but they must be uncompressed and have no
dictionary encoded strings.

### example query

some languages make getting split ints easy. clickhouse does not

```sql
-- clickhouse
select * except (index, h3) from (
    select *, reinterpretAsUInt64(reverse(unhex(index))) h3,
    toUInt32(bitAnd(h3, toUInt64(4294967295))) as index_lower,
    toUInt32(bitShiftRight(h3, 32)) as index_upper
    -- bitOr(toUInt64(index_lower), bitShiftLeft(toUInt64(index_upper),32)) -- validation
    from 'cartogram_weights.arrow'
)
into outfile 'cartogram_weights_hilo.arrow' settings output_format_arrow_compression_method = 'none'
```

julia makes it marginally easier

```julia
#!/usr/bin/env julia
using Arrow, DataFrames

df = # exercise for the reader
loweruint64(x) = x % UInt32
upperuint64(x) = (x >> 32) % UInt32

output = DataFrame(
    index_lower = loweruint64.(df.h3),
    index_upper = upperuint64.(df.h3),
    value = df.value,
)

Arrow.write("www/data/example.arrow", output; compress = nothing, dictencode = false)
```

## Metadata and settings

Put metadata alongside the data: `www/data/example.json` for `example.arrow`,
`example.csv` or `example.parquet`.

```json
{
  "t": "Population change",
  "c": "Example data provider",
  "cartogram": "none",
  "colourScheme": "interpolateViridis",
  "colourScale": "quantile"
}
```

| Key | description |
|-----|--------------|
| `t` | Browser and legend title. |
| `c` | Extra attribution names, separated by commas. |
| `colourScheme` | D3 colour interpolator, e.g. `interpolateViridis`. |
| `cyclical` | Use Rainbow instead of Spectral when no scheme is specified. because i always forget the names of each. |
| `flip` | flip the scale |
| `colourScale` | `quantile`, `rankit` (... squashes the linear quantile thing as if it were a normal distribution to compress the medians and stretch out the outliers. just look at the code), `linear` or `raw`. |
| `trimFactor` | Fraction to trim from each end of the legend |
| `quantileSource` | Scale against visible `map` (default) or `cartogram` values. |
| `legendBounds` | Fixed linear bounds `[min,max]`|
| `scale` | Numeric breakpoints and custom legend labels, or `null`. |
| `trains` | Show OpenRailwayMap maximum-speed tiles. |
| `crosshair` | Mark the map centre when `onmove` is enabled. default true. |
| `cartogram` | Mapping filename, blank/default for `cartogram_weights.arrow`, or `none`. which probably is a bad choice given most people don't have cartogram mappings. |
| `defaultValue` | Substitute for missing h3 contributors to cartogram cells that have other contributors; a number or `null`. |
| `infill` | Let that substitute fill wholly unobserved cartogram cells too. |
| `requireCompleteCoverage` | Makes missings infectious for the cartogram |

## Interaction endpoints

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
    "resolution": 5,
    "focus": false,
    "highlight": true
  }
}
```

`focus` moves the camera on click. `highlight` marks the selection

`{index}`, `{index_lower}`, `{index_upper}`, `{lat}`, `{lng}`, `{zoom}` and
`{controls.<id>}` will be substituted in the URL.

These plus `{TOWN_NAME}` for the nearest city/town are accepted in `t` for the
legend title.

## Request controls and shared links

Define each control under an ID in `controls`. Start the ID with a letter.
Use only letters, digits and underscores.

Supply `label`, `type` and `default` for each control.
Choose `number`, `time`, `text`, `select` or `boolean` for `type`.
Add `unit` and `help` if required.
For numbers and times, use `min`, `max` and `step` to configure the input.
For selects, supply `options`, for example `[{"value":"mean","label":"Mean"}]`.

To show a control only when a condition is true, add `showIf` to its definition:

```json
{
  "label": "Distance mode",
  "type": "select",
  "default": "straight_line",
  "options": [
    {"value": "straight_line", "label": "Straight line"},
    {"value": "network", "label": "Network"}
  ],
  "showIf": "values => values.metric === 'time_distance_quantile'"
}
```

`values` contains control inputs before conversion, keyed by ID. For selects, use option values, not labels.
Return `true` to show the control or `false` to hide it. Without `showIf`, the control is visible.
Use JavaScript conditions to combine comparisons:

```json
{
  "showIf": "values => ['time_distance_quantile', 'distance_time_quantile'].includes(values.metric) && values.window_size > 0"
}
```

Visibility updates when inputs change, including after Reset or loading a shared link.
Hidden controls keep their values in requests and shared links.
Invalid controls remain visible so you can correct them.
If a condition cannot be evaluated, its control remains visible with an error message.

To convert an input before sending it, supply `encode` as a JavaScript function string:

```json
{
  "encode": "(value, values) => value * 1000"
}
```

`value` is this control's input. `values` contains all control inputs, keyed by ID.
Both contain values before conversion.
Return a string, a finite number or a boolean. Do not return a Promise.

A valid control change sends a new request from the last query position.
Before the first query, it uses the map centre.
Invalid inputs or failed conversions prevent the request.

Titles show values before conversion. For selects, they show option labels.
They describe the displayed result, not a pending or failed request.

Shared links store input values before conversion as `p.<id>` parameters.
They store the query position in `query` JSON and the camera position after `#`.
The title keeps its placeholders.
Opening a link sends the query again; it does not load a saved result.

# Cartogram mapping spec

Cartograms are maps with complex projections, most commonly used for
visualising data with uniform populations rather than geographic projections
which attempt to preserve land area.

Creating such a projection is a non-trivial task. Our approach can be found in
https://github.com/bovine3dom/population-cartogram-projection but generally the
workflow is:

1) find some data that you want to represent uniformly (e.g. population) split
by some spatial unit (e.g. country)

2) by hand(!), create a pixel grid layout of the data where each cell is
assigned to a spatial unit and the total number of cells is equal to the
'population' of that spatial unit

3) create an H3 representation of the spatial units and join it with a high
resolution representation of the 'population'

4) use an algorithm to find the optimal fuzzy matching from H3 to the pixel
grid. the best algorithm to use is an open question - we are currently using
optimal transport with soft constraints.

Here, we support the following representation of such a mapping of many H3 -> many cells:


| Column | Type   | Description |
|--------|--------|-------------|
| `x`    | int    | column position, origin at top-left of screen |
| `y`    | int    | row position, origin at top-left of screen |
| `index_lower` | uint32 | H3 index, lower 32 bits|
| `index_upper` | uint32 | H3 index, upper 32 bits |
| `index`| string | H3 index, optional instead of split ints |
| `code` | int | country / subdivision code for border rendering |
| `label`| string | optional label text displayed on the cartogram cell |
| `weight`| float | weight for aggregation — `groupby(x, y)` weights should sum to 1 |

`x` increases to the right, `y` increases downward.

An excerpt of a possible `cartogram.arrow` follows:

```
    ┏━━━━━┳━━━━━┳━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━┳━━━━━━┳━━━━━━━━━━━━━━━━━┓
    ┃   x ┃   y ┃               weight ┃ label     ┃ code ┃ index           ┃
    ┡━━━━━╇━━━━━╇━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━╇━━━━━━╇━━━━━━━━━━━━━━━━━┩
 1. │ 354 │ 114 │                    1 │ Reykjavík │  352 │ 85075dd7fffffff │
    ├─────┼─────┼──────────────────────┼───────────┼──────┼─────────────────┤
 2. │ 388 │ 278 │   0.1995755129563892 │ ᴺᵁᴸᴸ      │  620 │ 85393363fffffff │
    ├─────┼─────┼──────────────────────┼───────────┼──────┼─────────────────┤
 3. │ 388 │ 278 │   0.1995755129563892 │ ᴺᵁᴸᴸ      │  620 │ 85393363fffffff │
    ├─────┼─────┼──────────────────────┼───────────┼──────┼─────────────────┤
 4. │ 386 │ 284 │   0.1995755129563892 │ ᴺᵁᴸᴸ      │  620 │ 85393363fffffff │
    ├─────┼─────┼──────────────────────┼───────────┼──────┼─────────────────┤
```

Then, the client will automatically load the data into both the standard map
and cartogram. At the time of writing, H3 is aggregated into cells using
weighted means, but weighted sums could be supported with a few lines of code. 

Split-index data selects the mapping's `_hilo.arrow` variant. If the h3 data
doesn't match the cartogram, it will be projected or aggregated. but this can
be slow.

## Attribution

Remember to add comma separated attribution for your data sources to `c`
