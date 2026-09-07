# TODO

# now

- use the same tiny-geocoder package to do a reverse lookup of the click event and replace {TOWN_NAME} in the legend if it exists

- consider rankit transform (blom's formula + probit function on rank) for display optionally instead of uniform in quantile space - basically displays them along a normal distribution instead, giving the tails some more room and compressing the median so small deviations near the median don't lead to large variations in colour. but, obvs, the colour on the map will be less evenly spread.

- [x] fix lack of legend colour/rescale on data load after click. workaround: user must move map a little after load

- make clicked tile highlighted somehow so it is obvious where the centre is?

- [x] add "freeze legend" button to settings. it'll need to bake the bounds in + read them from the current state

# later

- go over settings pane again and check ux. there should be only one way to do something (e.g. duplicated reset buttons)

- rephrase help text
