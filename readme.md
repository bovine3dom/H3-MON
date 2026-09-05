# H3-MON: THE MOST POWERFUL MON(itor) IN THE UNIVERSE

A simple data vis tool using MapLibre GL and deck.gl to display and refresh data from CSV/Arrow/Parquet files. GeoJSON supported experimentally.

<p align="center">
<img src="promo/demo.png" alt="An astonishingly beautiful map of the UK">
</p>


# How to run

Prerequisites: yarn. A web browser. A CSV file of index, value for [H3 Hexagon indices](https://h3geo.org/).

0. `git clone`
1. `yarn install`
2. bung data in `./www/data/h3_data.{csv, arrow, parquet}` with index (hex strings), values and optionally weights
3. `yarn serve&; yarn watch`, open localhost:1983/?data=h3_data{,.csv, .arrow, .parquet}
4. data will be refreshed with a file watcher

# Metadata and view settings

For a data file named `example.arrow`, H3-MON loads metadata from `www/data/example.json`. Query-string values override metadata values, so existing links such as `?data=example.arrow&flip&raw=false` continue to work and views configured in the settings panel can be shared directly.

The always-visible cog opens the view settings panel. Selects and toggles apply immediately. Text fields that only affect presentation use leading throttle-debounce: the first change is immediate and the final value is applied after typing stops. Settings that combine typing with a data or cartogram rebuild are staged until **Apply pending** is pressed.

| Key | Name | Type | Description |
|-----|------|------|-------------|
| `t` | Title | string | Browser and legend title. |
| `c` | Additional attribution | comma-separated string | Attribution names prepended to the standard credits. |
| `colourScheme` | Colour scheme | D3 interpolator name | Continuous D3 colour interpolator, such as `interpolateViridis`. |
| `cyclical` | Cyclical colours | boolean | Uses Rainbow instead of Spectral when no explicit colour scheme is set. |
| `flip` | Reverse colours | boolean | Reverses the colour scale. |
| `raw` | Use raw values | boolean | Colours by source values instead of quantiles. |
| `trimFactor` | Legend trim factor | number from 0 to less than 0.5 | Trims the ends of quantile legends. |
| `quantileSource` | Quantile source | `map` or `cartogram` | Chooses which visible values determine quantiles. |
| `scale` | Scale labels | object or null | Maps numeric breakpoints to raw legend labels. |
| `trains` | Railway speeds | boolean | Shows OpenRailwayMap maximum-speed tiles. |
| `cartogram` | Cartogram weights | filename, default-like value, or `none` | Selects a weights file or disables the cartogram. |
| `defaultValue` | Missing value | number or null | Fallback used for missing contributors during cartogram aggregation. |
| `infill` | Infill empty cells | boolean | Allows the missing value to fill wholly unobserved cartogram cells. |

Boolean URL values retain the existing accepted forms: bare parameters and most values enable a setting, while `0`, `false`, `off`, and `no` disable it. The settings panel writes explicit `1` or `0` values and preserves unrelated query parameters and the map-position hash.

Example metadata:

```json
{
  "t": "Population change",
  "c": "Example data provider",
  "colourScheme": "interpolateViridis",
  "flip": false,
  "trimFactor": 0.01,
  "quantileSource": "cartogram",
  "defaultValue": 0,
  "infill": true,
  "scale": {
    "0": "No change",
    "1": "Largest increase"
  }
}
```

Future interaction endpoints will use the same schema rather than executable metadata. The intended shape is a structured `onclick` or `onmove` object containing a URL and delivery options; movement delivery should be leading throttle-debounce and limited to user-originated movement to avoid map/cartogram synchronization loops.

# Cartogram mapping spec

Cartograms are maps with complex projections, most commonly used for visualising data with uniform populations rather than geographic projections which attempt to preserve land area.

Creating such a projection is a non-trivial task. Our approach can be found in https://github.com/bovine3dom/population-cartogram-projection but generally the workflow is:

1) find some data that you want to represent uniformly (e.g. population) split by some spatial unit (e.g. country)
2) by hand(!), create a pixel grid layout of the data where each cell is assigned to a spatial unit and the total number of cells is equal to the 'population' of that spatial unit
3) create an H3 representation of the spatial units and join it with a high resolution representation of the 'population'
4) use an algorithm to find the optimal fuzzy matching from H3 to the pixel grid. the best algorithm to use is an open question - we are currently using optimal transport with soft constraints.

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

Then, provided you have data in `csv` or `arrow` format (not parquet), the client will automatically load the data into both the standard map and cartogram. At the time of writing, H3 is aggregated into cells using weighted means, but weighted sums could be supported with a few lines of code.

# Example query

```sql
-- clickhouse
select substring(lower(hex(h3)),2) index, count()::Int32 value, weight::Int32 weight from (
 select geoToH3(stop_lat, stop_lon, 5) h3, * from transitous_everything_20260218_stop_times_one_day_even_saner2 t
 left join (
  select h3ToParent(h3, 5) h3_t, sum(population) weight from public_kontur_population_20231101
  group by h3_t
 ) k on k.h3_t = h3
)
group by all
into outfile 'total_stops_weighted.parquet' truncate
```

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

```julia
#/bin/julia
loweruint64(x) = x % UInt32
upperuint64(x) = (x >> 32) % UInt32
```
