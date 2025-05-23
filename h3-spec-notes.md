# h3 spec notes


h3-mon unification:

endpoint for metadata, overridden by query params
- tells whether to watch
- tells whether/when to update (onmove, onmoveend, once) with what params
endpoint for data, arrow or csv
- geometry type? H3, LSOA
- returns function obj => url to fetch, gets eval'd and cached
- obj by default is {x, y, z, bbox}
- can be tweaked with params e.g. {age: {type: slider, min: 5, max: 24, description: time}} ?
- format

csv/arrow reunification going to be tricky

quantile reunification going to be tricky

workaround: some combinations of settings throw not implemented errors?



- not sure i like js function eval, means something somewhere always has to be eval'd?
- probably better to just have query params on the fetch endpoint?

for params: look at json schema
