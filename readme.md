# H3-MON: THE MOST POWERFUL MON(itor) IN THE UNIVERSE

A simple data vis tool using MapLibre GL and deck.gl to display and refresh data from a CSV file.

<p align="center">
<img src="promo/demo.png" alt="An astonishingly beautiful map of the UK">
</p>


# How to run

Prerequisites: yarn, caddy (or some other web server). A web browser.

0. `git clone`
1. `yarn install`
2. bung data in `./www/data/h3_data.csv` with index (hex strings), values normalised from 0-1
3. `yarn serve&; yarn watch`, open localhost:8000
4. update data however you like, it gets refreshed every few seconds
