# TODO

# now

- use the same tiny-geocoder package to do a reverse lookup of the click event and replace {TOWN_NAME} in the legend if it exists

- [x] optional rankit transform (Blom's formula + probit on rank) instead of uniform quantiles; gives tails more colour space and compresses the median.

- [x] fix lack of legend colour/rescale on data load after click. workaround: user must move map a little after load

- [x] highlight the clicked origin independently of camera focus; retain the last successful result's selection during pending or failed queries.

- [x] add "freeze legend" button to settings. it'll need to bake the bounds in + read them from the current state

# later

- go over settings pane again and check ux. there should be only one way to do something (e.g. duplicated reset buttons)

- rephrase help text
