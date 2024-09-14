# French IRIS tiled map

A simple data vis tool using MapLibre GL and deck.gl to display data from a CSV file joined with the French INSEE communes

<p align="center">
<img src="promo/demo.png" alt="Chloropleth map of Paris showing percentage of principal residences without cars">
</p>

# How to run

Prerequisites: yarn. A web browser. A CSV file of IRIS code, value.

0. `git clone`
1. `yarn install`
2. bung data in `./www/data/iris_data.csv` with numeric IRIS code, values normalised from 0-1
3. `yarn serve&; yarn watch`, open localhost:1983
4. reload page to reload data

(nb: at the moment the value column is called perc_voit and the tooltip hardcodes it as percent_zero_voitures)


# Dealing with France

convert lambert 93 (or other) shapefile with wgs84 geojson then make tiles
```
ogr2ogr -f GeoJSON -t_srs EPSG:4326 iris_2020.geojson CONTOURS-IRIS.shp 
tippecanoe -zg --coalesce-smallest-as-needed --no-tile-compression -e tiles iris_2020.geojson # pay attention to min/max zoom in tiles directory and set to right value in deck.gl
```

# Copyright
IRIS tiles copyright INSEE and IGN
