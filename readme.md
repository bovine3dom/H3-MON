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
| `index`| string | H3 index |
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
