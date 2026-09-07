# TODO

# now

- use the same tiny-geocoder package to do a reverse lookup of the click event and replace {TOWN_NAME} in the legend if it exists

- [x] optional rankit transform (Blom's formula + probit on rank) instead of uniform quantiles; gives tails more colour space and compresses the median.

- [x] fix lack of legend colour/rescale on data load after click. workaround: user must move map a little after load

- make clicked tile highlighted somehow so it is obvious where the centre is?

- [x] add "freeze legend" button to settings. it'll need to bake the bounds in + read them from the current state

# later

- go over settings pane again and check ux. there should be only one way to do something (e.g. duplicated reset buttons)

- rephrase help text
