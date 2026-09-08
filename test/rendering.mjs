import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {PNG} from 'pngjs';
import {cellToBoundary, cellToChildren, cellToParent, cellToLatLng, gridDisk, h3IndexToSplitLong, splitLongToH3Index, latLngToCell} from 'h3-js';
import {tableFromArrays, tableToIPC} from 'apache-arrow';
import {findClosestCity} from 'tiny-geocoder';
import {colourScale} from '../src/settings.js';

// Test the built application, never local user data or a replacement Deck layer.
const www = new URL('../www/', import.meta.url);
const cell = '851fb467fffffff';
const center = cellToLatLng(cell).reverse();
const boundary = cellToBoundary(cell, true);
const background = '#5890aa';
const reference = {
    type: 'FeatureCollection',
    features: [boundary, [[center[0] - 0.4, center[1]], [center[0] + 0.4, center[1]]],
        [[center[0], center[1] - 0.3], [center[0], center[1] + 0.3]]].map(coordinates => ({
        type: 'Feature', properties: {}, geometry: {type: 'LineString', coordinates},
    })),
};
const style = {
    version: 8, transition: {duration: 0, delay: 0},
    sources: {reference: {type: 'geojson', data: reference}},
    layers: [
        {id: 'background', type: 'background', paint: {'background-color': background}},
        {id: 'reference', type: 'line', source: 'reference', paint: {'line-color': '#18303c', 'line-width': 2}},
    ],
};
const routes = new Map([
    ['/toner_ofm_moderatlist.json', ['application/json', JSON.stringify(style)]],
    ['/data/rendering.json', ['application/json', JSON.stringify({cartogram: 'none', raw: true, colourScheme: 'interpolateReds'})]],
    ['/data/rendering.csv', ['text/csv', `index,value\n${cell},0.65\n`]],
    ['/favicon.ico', ['image/x-icon', '']],
]);
const scaleCells = [cell, ...gridDisk(cell, 1).filter(index => index !== cell).slice(0, 2), latLngToCell(0, 0, 5)];
// Exercise production math without importing the application's DOM/bootstrap side effects.
const appSource = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const mathNames = ['columnValue', 'columnLength', 'toNumber', 'toFiniteNumber', 'toStringValue',
    'hasSplitH3Index', 'h3RowCount', 'h3IndexStringAt', 'ensureH3StringColumn', 'splitMapGet', 'splitMapHas', 'splitMapSet',
    'getDefaultValue', 'indexValuesByH3', 'indexFiniteSplitValuesByH3', 'projectedH3Columns', 'cartoProjectionConfig',
    'aggregateTargetMeans', 'aggregateSameResolutionSplitCartogram', 'groupCartogramWithMap', 'projectH3ToCartoResolution'];
const mathSource = mathNames.map(name => {
    const match = appSource.match(new RegExp(`^( *)(?:async )?function ${name}\\(`, 'm'));
    assert(match, `Production function ${name} exists`);
    const end = appSource.indexOf(`\n${match[1]}}`, match.index);
    assert(end > match.index, `Production function ${name} has a closing brace`);
    return appSource.slice(match.index, end + match[1].length + 2);
}).join('\n');
const h3Columns = indexes => ({
    index_lower: Uint32Array.from(indexes, index => h3IndexToSplitLong(index)[0]),
    index_upper: Uint32Array.from(indexes, index => h3IndexToSplitLong(index)[1]),
});
const coverageMath = new Function('settings', 'cartogramAgg', 'cellToChildren', 'cellToParent', 'splitLongToH3Index', 'colourScale', `
    const H3_INDEX_LOWER = 'index_lower', H3_INDEX_UPPER = 'index_upper', cartoRes = 5;
    const requireCompleteCoverage = settings.requireCompleteCoverage, infill = settings.infill;
    const perfTimer = () => () => {};
    const cartoProjectionBuffers = async () => ({cartoH3s: cartogramAgg.h3Cols.index,
        indexes: new Array(cartogramAgg.h3Cols.index.length)});
    ${mathSource}
    return {groupCartogramWithMap, projectH3ToCartoResolution};
`);
const aggregateFixture = (indexes, rowCell = indexes.map(() => 0), weights = null) => ({
    h3Cols: {index: indexes, ...h3Columns(indexes)}, rowCell, weightValues: weights,
    x: [...new Set(rowCell)], y: [...new Set(rowCell)],
});
const mathFor = (settings, fixture) => coverageMath(settings, fixture, cellToChildren, cellToParent, splitLongToH3Index, colourScale);
for (const split of [false, true]) {
    for (const missing of [undefined, null, NaN]) {
        for (const weight of [1, 0]) {
            for (const strict of [false, true]) {
                for (const defaultValue of [null, 12]) {
                    const indexes = missing === undefined ? [cell] : scaleCells.slice(0, 2);
                    const source = {...(split ? h3Columns(indexes) : {index: indexes}), value: indexes.map((_, i) => i ? missing : 6)};
                    const math = mathFor({requireCompleteCoverage: strict, defaultValue, infill: true},
                        aggregateFixture(scaleCells.slice(0, 2), [0, 0], [1, weight]));
                    assert.deepEqual(math.groupCartogramWithMap(source, 'value').aggCols.value_mean,
                        [strict && weight ? null : defaultValue != null && weight ? 9 : 6],
                        `split=${split}, missing=${missing}, weight=${weight}, strict=${strict}, default=${defaultValue}`);
                }
            }
        }
    }
    for (const values of [[0, 0], [0, 8], [null, null]]) {
        const indexes = scaleCells.slice(0, 2);
        for (const weights of [null, [1, 3]]) {
            for (const defaultValue of [null, 12]) {
                const math = mathFor({requireCompleteCoverage: true, defaultValue, infill: true}, aggregateFixture(indexes, [0, 0], weights));
                assert.deepEqual(math.groupCartogramWithMap({...(split ? h3Columns(indexes) : {index: indexes}), value: values}, 'value').aggCols.value_mean,
                    [values[1] === null ? null : values[1] * (weights ? 3 / 4 : 1 / 2)],
                    'Complete data including zero stays numeric; wholly missing targets cannot be infilled');
            }
        }
    }
}
for (const strict of [false, true]) {
    const math = mathFor({requireCompleteCoverage: strict, defaultValue: 12, infill: true}, aggregateFixture([cell]));
    const children = cellToChildren(cell, 6);
    for (const [index, value, resolution, expected] of [
        [children.slice(1), children.slice(1).map(() => 0), 6, strict ? null : 12 / children.length],
        [children, children.map(() => 0), 6, 0],
        [[cellToParent(scaleCells[3], 4)], [8], 4, null],
        [[cellToParent(cell, 4)], [0], 4, 0],
    ]) {
        const {grouped} = await math.projectH3ToCartoResolution({index, value}, 'value', resolution);
        assert.deepEqual(grouped.value, [expected], `Projected resolution ${resolution}, strict=${strict}`);
        assert.deepEqual(math.groupCartogramWithMap(grouped, 'value').aggCols.value_mean,
            [expected === null && !strict ? 12 : expected], 'Final aggregation cannot refill a strict missing parent');
    }
}
console.log('Complete coverage: general/split aggregation, defaults, zero weights and resolution projection passed');
const scaleResponse = (values, weights) => Buffer.from(tableToIPC(tableFromArrays({
    index_lower: Uint32Array.from(scaleCells, index => h3IndexToSplitLong(index)[0]),
    index_upper: Uint32Array.from(scaleCells, index => h3IndexToSplitLong(index)[1]),
    value: Float64Array.from(values),
    ...(weights ? {weight: Float64Array.from(weights)} : {}),
})));
routes.set('/data/scaling.json', ['application/json', JSON.stringify({cartogram: 'none', trimFactor: 0,
    onclick: {url: '/scaling-result?index={index}', focus: false, highlight: false},
})]);
routes.set('/data/scaling.csv', ['text/csv', `index,value\n${cell},1\n`]);
routes.set('/data/selection.csv', routes.get('/data/scaling.csv'));
routes.set('/data/selection_hilo.arrow', ['application/octet-stream', Buffer.from(tableToIPC(tableFromArrays({
    x: Int32Array.from([0, 2, 4]), y: Int32Array.from([0, 2, 0]), code: Int32Array.from([100, 100, 100]),
    index_lower: Uint32Array.from(scaleCells.slice(0, 3), index => h3IndexToSplitLong(index)[0]),
    index_upper: Uint32Array.from(scaleCells.slice(0, 3), index => h3IndexToSplitLong(index)[1]),
})))]);
routes.set('/data/coverage.json', ['application/json', JSON.stringify({
    cartogram: 'coverage-cartogram_hilo.arrow', requireCompleteCoverage: false, trimFactor: 0,
})]);
routes.set('/data/coverage.arrow', ['application/octet-stream', scaleResponse([0.6, NaN, 0, 0.8])]);
routes.set('/data/coverage-cartogram_hilo.arrow', ['application/octet-stream', Buffer.from(tableToIPC(tableFromArrays({
    ...h3Columns(scaleCells), x: Int32Array.from([0, 0, 2, 4]), y: Int32Array.from([0, 0, 2, 0]),
    code: Int32Array.from([100, 100, 100, 100]), weight: Float64Array.from([1, 1, 1, 1]),
})))]);
for (const [name, type] of [['index.html', 'text/html'], ['app.js', 'text/javascript'], ['app.css', 'text/css']]) {
    routes.set(`/${name}`, [type, await readFile(new URL(name, www))]);
}
routes.set('/', routes.get('/index.html'));
assert(!routes.get('/app.css')[1].toString().includes('.maplibregl-map'), 'Do not bundle the unused MapLibre stylesheet');
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const route = routes.get(path);
    if (!route) failures.push(`Unexpected HTTP request: ${path}`);
    response.writeHead(route ? 200 : 404, {'Content-Type': route?.[0] || 'text/plain', 'Cache-Control': 'no-store'});
    response.end(route?.[1] || '');
});
const artifacts = process.env.ARTIFACT_DIR;
let browser;

async function settle(page) {
    await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished)));
    // Let the application's normal resize handling settle; do not repair it in the test.
    await page.waitForFunction(() => {
        const container = m.getContainer().getBoundingClientRect();
        return [m.getCanvas(), document.getElementById('deckgl-overlay')].every(canvas => {
            const rect = canvas.getBoundingClientRect();
            return Math.abs(rect.width - container.width) <= 1 && Math.abs(rect.height - container.height) <= 1;
        });
    });
    await page.evaluate(async () => {
        const idle = new Promise((resolve, reject) => {
            const done = () => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(() => {
                m.off('idle', done);
                reject(new Error('Map did not finish rendering within 10 seconds'));
            }, 10000);
            m.once('idle', done);
        });
        m.triggerRepaint();
        await idle;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
}

function rgb(image, [x, y]) {
    assert(x >= 0 && y >= 0 && x < image.width && y < image.height, `Pixel outside screenshot: ${x},${y}`);
    const offset = (Math.floor(y) * image.width + Math.floor(x)) * 4;
    // Array.from matters: Buffer.map would truncate fractional expected RGB values.
    return Array.from(image.data.subarray(offset, offset + 3));
}
const difference = (a, b) => Math.max(...a.map((value, i) => Math.abs(value - b[i])));
const red = colour => colour[0] > colour[1] + 25 && colour[1] < 240;

async function frame(page, name, paneOpen = false) {
    await settle(page);
    const geometry = await page.evaluate(points => {
        const canvas = document.getElementById('deckgl-overlay');
        // Private access is confined to this test: production needs no test hook.
        const overlay = m._controls.find(control => control.getCanvas?.()?.id === 'deckgl-overlay');
        const viewport = overlay._deck.getViewports()[0];
        const rect = element => {
            const {x, y, width, height} = element.getBoundingClientRect();
            return {x, y, width, height};
        };
        const map = rect(m.getCanvas()), deck = rect(canvas), wrapper = rect(canvas.parentElement);
        return {
            map, deck, wrapper, viewport: {width: viewport.width, height: viewport.height},
            mapPoints: points.map(point => { const p = m.project(point); return [map.x + p.x, map.y + p.y]; }),
            deckPoints: points.map(point => { const p = viewport.project(point); return [deck.x + p[0], deck.y + p[1]]; }),
            blend: getComputedStyle(canvas).mixBlendMode,
            inline: {visibility: canvas.style.visibility, mixBlendMode: canvas.style.mixBlendMode},
            occluders: [...document.querySelectorAll('#search-container, .maplibregl-ctrl, .pane-btn, #attribution, #legend, .utility-controls')]
                .filter(element => getComputedStyle(element).visibility !== 'hidden').map(rect),
        };
    }, [center, ...boundary]);
    const {map, deck, wrapper, viewport, mapPoints, deckPoints, inline} = geometry;
    const size = page.viewportSize();
    const expectedSize = [size.width / (paneOpen && size.width > size.height ? 2 : 1),
        size.height / (paneOpen && size.height > size.width ? 2 : 1)];
    check(difference([map.width, map.height], expectedSize) <= 1, `${name}: pane did not produce expected map size ${expectedSize}`);
    const rectError = Math.max(...[deck, wrapper].flatMap(rect => ['x', 'y', 'width', 'height'].map(key => Math.abs(rect[key] - map[key]))));
    const projectionError = Math.max(...mapPoints.map((point, i) => Math.hypot(point[0] - deckPoints[i][0], point[1] - deckPoints[i][1])));
    check(rectError <= 1, `${name}: canvas/wrapper alignment error ${rectError.toFixed(2)} CSS px`);
    check(difference([viewport.width, viewport.height], [map.width, map.height]) <= 1, `${name}: stale Deck viewport size`);
    check(projectionError <= 1, `${name}: geographic projection error ${projectionError.toFixed(2)} CSS px`);
    check(geometry.blend === 'multiply', `${name}: computed mix-blend-mode is ${geometry.blend}`);

    const screenshot = async suffix => {
        await settle(page);
        const image = PNG.sync.read(await page.screenshot({scale: 'css',
            ...(artifacts ? {path: join(artifacts, `${name}-${suffix}.png`)} : {}),
        }));
        assert.equal(image.width, size.width, 'Screenshots must use CSS pixels, including DPR 2');
        assert.equal(image.height, size.height);
        return image;
    };
    let baseline, white;
    try {
        await page.evaluate(() => { document.getElementById('deckgl-overlay').style.visibility = 'hidden'; });
        baseline = await screenshot('basemap');
        await page.evaluate(visibility => {
            const canvas = document.getElementById('deckgl-overlay');
            canvas.style.visibility = visibility;
            canvas.style.mixBlendMode = 'normal';
            m.setPaintProperty('background', 'background-color', '#ffffff');
            m.setLayoutProperty('reference', 'visibility', 'none');
        }, inline.visibility);
        white = await screenshot('white-normal');
    } finally {
        await page.evaluate(({inline, background}) => {
            Object.assign(document.getElementById('deckgl-overlay').style, inline);
            m.setPaintProperty('background', 'background-color', background);
            m.setLayoutProperty('reference', 'visibility', 'visible');
        }, {inline, background});
    }
    const multiplied = await screenshot('multiply');
    const safe = ([x, y]) => x > map.x + 1 && y > map.y + 1 && x < map.x + map.width - 1 && y < map.y + map.height - 1
        && x < white.width - 1 && y < white.height - 1
        && !geometry.occluders.some(r => r.width && r.height && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
    // Sample the actual Deck centre so a displaced polygon cannot hide the blend bug.
    const sample = deckPoints[0];
    assert(safe(sample), `${name}: centre obscured by controls or outside map`);
    const baseRGB = rgb(baseline, sample), whiteRGB = rgb(white, sample), actualRGB = rgb(multiplied, sample);
    const expectedRGB = baseRGB.map((value, i) => value * whiteRGB[i] / 255);
    const blendError = difference(actualRGB, expectedRGB);
    check(red(whiteRGB), `${name}: white frame has no red H3 at Deck centre: ${whiteRGB}`);
    check(blendError <= 4, `${name}: multiply RGB ${actualRGB}, expected ${expectedRGB.map(Math.round)} (error ${blendError.toFixed(2)})`);

    // Check rasterized polygon edges, independently of Deck's reported viewport.
    let edges = 0, badEdges = 0;
    for (let i = 1; i < mapPoints.length - 1; i++) {
        const midpoint = mapPoints[i].map((value, axis) => (value + mapPoints[i + 1][axis]) / 2);
        const toward = midpoint.map((value, axis) => mapPoints[0][axis] - value);
        const length = Math.hypot(...toward);
        const inner = midpoint.map((value, axis) => value + 3 * toward[axis] / length);
        const outer = midpoint.map((value, axis) => value - 3 * toward[axis] / length);
        if (!safe(inner) || !safe(outer)) continue;
        edges++;
        if (!red(rgb(white, inner)) || difference(rgb(white, outer), [255, 255, 255]) > 5) badEdges++;
    }
    check(edges >= 3, `${name}: only ${edges} unobscured polygon edges`);
    check(badEdges === 0, `${name}: ${badEdges}/${edges} rasterized H3 edges disagree with MapLibre (+/-3 CSS px)`);
    console.log(JSON.stringify({name, map, deck, rectError, projectionError, blendError, baseRGB, whiteRGB, expectedRGB, actualRGB, edges, badEdges}));
}

try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    if (artifacts) await mkdir(artifacts, {recursive: true});
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH,
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
    });
    for (const [device, width, height, deviceScaleFactor] of [['desktop', 1200, 850, 1], ['mobile', 375, 812, 2]]) {
        const context = await browser.newContext({viewport: {width, height}, deviceScaleFactor, reducedMotion: 'reduce', serviceWorkers: 'block'});
        const page = await context.newPage();
        page.setDefaultTimeout(20000);
        await context.routeWebSocket('**/*', socket => socket.onMessage(message => {
            if (String(message).startsWith('watch:')) socket.send('watching:rendering.csv');
        }));
        page.on('pageerror', error => failures.push(`${device}: pageerror: ${error.stack || error}`));
        page.on('console', message => {
            const text = message.text();
            if (text.startsWith('Error: Expected to read 1635151465 metadata bytes, but only read 9.')) return; // Deliberate invalid-arrow payload.
            if (text.includes('HTTP 503: selection-test-failure') || text === 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)') return;
            if (text === 'Error: <g> attribute transform: Expected transform function, "0".') return;
            if (message.type() === 'error') failures.push(`${device}: console: ${text}`);
            else if (message.type() === 'warning') console.warn(`${device}: ${text}`);
        });
        await context.route('**/*', route => {
            if (new URL(route.request().url()).origin === origin) return route.continue();
            failures.push(`${device}: unexpected external request: ${route.request().url()}`);
            return route.abort();
        });
        try {
            await page.goto(`${origin}/?data=rendering.csv#x=${center[0]}&y=${center[1]}&z=8`);
            await page.waitForFunction(cell => document.body.classList.contains('load-complete') && window.m?.loaded()
                && window._columnData?.index?.length === 1 && window._columnData.index[0] === cell
                && window._columnData.value[0] === 0.65, cell);
            check(await page.locator('.maplibregl-ctrl-group').count() === 0, `${device}: unwanted native map controls`);
            await page.mouse.move(0, 0);
            await frame(page, `${device}-closed-flat`);
            await page.evaluate(() => m.jumpTo({bearing: 30, pitch: 35}));
            await frame(page, `${device}-closed-tilted`);
            await page.evaluate(center => m.jumpTo({center: [center[0] + 0.025, center[1] + 0.015], zoom: 7.7}), center);
            await frame(page, `${device}-pan-zoom`);
            // Enable existing pane CSS and button logic; Help overlaps the closed-pane button.
            await page.evaluate(() => {
                document.body.classList.remove('pane-open', 'pane-full');
                document.body.classList.add('cartogram-ready');
            });
            await page.locator('#leftExpand').evaluate(button => button.click());
            await frame(page, `${device}-pane-open`, true);
            await page.locator('#rightExpand').evaluate(button => button.click());
            await settle(page);
            check(await page.locator('#map').isHidden(), `${device}: full pane did not hide map`);
            await page.locator('#rightExpand').evaluate(button => button.click());
            await frame(page, `${device}-pane-reopen`, true);
            await page.locator('#leftExpand').evaluate(button => button.click());
            await frame(page, `${device}-pane-closed-again`);
            await page.setViewportSize({width: height, height: width});
            await frame(page, `${device}-orientation-closed`);
            await page.locator('#leftExpand').evaluate(button => button.click());
            await frame(page, `${device}-orientation-open`, true);

            // Crosshair visibility follows query capability, independently of data loading.
            routes.set('/data/crosshair.csv', routes.get('/data/rendering.csv'));
            const reticule = page.locator('#reticule');
            const crosshair = page.getByRole('checkbox', {name: 'Centre crosshair', exact: true});
            for (const [metadata, query, visible] of [
                [{}, '&crosshair=true', false],
                [{onmove: {url: '/data/crosshair.csv'}}, '&onmove=false&crosshair=true', false],
                [{onmove: {url: '/data/crosshair.csv'}}, '', true],
                [{onmove: {url: '/data/crosshair.csv'}, crosshair: false}, '', false],
                [{onmove: {url: '/data/crosshair.csv'}, crosshair: false}, '&crosshair=true', true],
                [{onmove: {url: '/data/crosshair.csv'}}, '&crosshair=false', false],
            ]) {
                routes.set('/data/crosshair.json', ['application/json', JSON.stringify({
                    cartogram: 'none', raw: true, ...metadata,
                })]);
                await page.goto('about:blank');
                await page.goto(`${origin}/?data=crosshair.csv${query}#x=${center[0]}&y=${center[1]}&z=8`);
                await page.waitForFunction(() => document.body.classList.contains('load-complete'));
                await reticule.waitFor({state: visible ? 'visible' : 'hidden'});
                await page.locator('#settingsBtn').click();
                assert.equal(await crosshair.isChecked(), !query.includes('crosshair=false')
                    && (query.includes('crosshair=true') || metadata.crosshair !== false));
                const requests = [];
                const record = request => requests.push(request.url());
                page.on('request', record);
                try {
                    await crosshair.uncheck();
                    await reticule.waitFor({state: 'hidden'});
                    await crosshair.check();
                    await reticule.waitFor({state: metadata.onmove && !query.includes('onmove=false') ? 'visible' : 'hidden'});
                    await page.locator('#settingsResetAll').click();
                    await page.waitForFunction(() => !new URL(location.href).searchParams.has('crosshair'));
                    assert.equal(await crosshair.isChecked(), metadata.crosshair !== false, 'Reset restores metadata, not just schema default');
                    await reticule.waitFor({state: metadata.onmove && !query.includes('onmove=false')
                        && metadata.crosshair !== false ? 'visible' : 'hidden'});
                    await settle(page);
                    assert.deepEqual(requests, [], 'Crosshair checkbox and reset must not refetch data');
                } finally {
                    page.off('request', record);
                }
                await page.locator('#settingsClose').click();
            }
            const checkCrosshairCenter = async () => {
                await settle(page);
                await reticule.waitFor({state: 'visible'});
                const geometry = await reticule.evaluate(element => {
                    const r = element.getBoundingClientRect(), map = m.getCanvas().getBoundingClientRect();
                    const style = getComputedStyle(element);
                    return {offset: [r.x + r.width / 2 - map.x - map.width / 2,
                        r.y + r.height / 2 - map.y - map.height / 2],
                    size: [r.width, r.height], position: style.position, pointerEvents: style.pointerEvents};
                });
                assert(geometry.offset.every(value => Math.abs(value) <= 1), `${device}: crosshair must follow geographic pane centre`);
                assert.deepEqual(geometry.size, [80, 80]);
                assert.equal(geometry.position, 'absolute');
                assert.equal(geometry.pointerEvents, 'none');
                assert.equal(await reticule.locator('svg').count(), 1);
            };
            await page.setViewportSize({width, height});
            await checkCrosshairCenter();
            await page.evaluate(() => document.body.classList.add('cartogram-ready'));
            await page.locator('#leftExpand').evaluate(button => button.click());
            await checkCrosshairCenter();
            await page.setViewportSize({width: height, height: width});
            await checkCrosshairCenter();
            await page.locator('#rightExpand').evaluate(button => button.click());
            await reticule.waitFor({state: 'hidden'});
            await page.locator('#rightExpand').evaluate(button => button.click());
            await checkCrosshairCenter();
            await page.locator('#leftExpand').evaluate(button => button.click());
            await checkCrosshairCenter();
            console.log(`${device}: crosshair visibility, settings and pane regressions passed`);

            // A click response must use the visible distribution without a subsequent move.
            routes.set('/scaling-result', ['application/octet-stream', scaleResponse([10, 20, 110, 10000])]);
            await page.goto(`${origin}/?data=scaling.csv#x=${center[0]}&y=${center[1]}&z=7`);
            await page.waitForFunction(() => document.body.classList.contains('load-complete'));
            const clickCell = async (index = cell) => {
                const point = await page.evaluate(center => {
                    const p = m.project(center), rect = m.getCanvas().getBoundingClientRect();
                    return {x: rect.x + p.x, y: rect.y + p.y};
                }, cellToLatLng(index).reverse());
                await page.mouse.click(point.x, point.y);
            };
            const checkScaleColour = async () => {
                await settle(page);
                const {point, colour} = await page.evaluate(center => {
                    const p = m.project(center), rect = m.getCanvas().getBoundingClientRect();
                    const overlay = m._controls.find(control => control.getCanvas?.()?.id === 'deckgl-overlay');
                    const layer = overlay._deck.props.layers.find(layer => layer.id === 'H3HexagonLayer');
                    return {point: [rect.x + p.x, rect.y + p.y],
                        colour: layer.props.getFillColor(null, {index: 0, data: layer.props.data, target: []})};
                }, center);
                const actual = rgb(PNG.sync.read(await page.screenshot({scale: 'css'})), point);
                const expected = [24, 48, 60].map((base, i) => base * colour[i] / 255);
                assert(difference(actual, expected) <= 4, `Stale map colour: ${actual}, expected ${expected}`);
                return actual;
            };
            await clickCell();
            await page.waitForFunction(() => window._columnData?.value[0] === 10
                && Math.abs(window._columnData.quantile[0] - 1 / 3) < 1e-6);
            await checkScaleColour();
            const scaleSelector = page.getByRole('combobox', {name: 'Colour scale', exact: true});
            const replayURL = page.url();
            const scaleMetadata = routes.get('/data/scaling.json');
            routes.set('/data/scaling.json', ['application/json', JSON.stringify({
                ...JSON.parse(scaleMetadata[1]), colourScale: 'rankit', raw: true,
            })]);
            for (let mask = 0; mask < 8; mask++) {
                const legacy = new URL(replayURL);
                const flags = {raw: mask & 1 ? 'true' : 'false', linear: mask & 2 ? '1' : '0', rankit: mask & 4 ? 'on' : 'off'};
                for (const [key, value] of Object.entries(flags)) legacy.searchParams.set(key, value);
                const mode = mask & 1 ? 'raw' : mask & 2 ? 'linear' : mask & 4 ? 'rankit' : 'quantile';
                await page.goto(legacy.href);
                await page.waitForFunction(() => document.body.classList.contains('load-complete') && window._columnData?.value[0] === 10);
                const pixels = await checkScaleColour();
                const quantiles = await page.evaluate(() => window._columnData.quantile ?? null);
                await page.locator('#settingsBtn').click();
                assert.equal(await scaleSelector.inputValue(), mode, `Legacy precedence for ${legacy.search}`);
                assert.equal(await page.locator('#setting-raw, #setting-linear, #setting-rankit').count(), 0);
                await page.getByRole('textbox', {name: 'Title', exact: true}).fill('Legacy title');
                await page.waitForFunction(() => new URL(location.href).searchParams.get('t') === 'Legacy title');
                for (const [key, value] of Object.entries(flags)) assert.equal(new URL(page.url()).searchParams.get(key), value);
                assert.equal(new URL(page.url()).searchParams.has('colourScale'), false, 'Unrelated edits do not canonicalize legacy flags');
                assert.deepEqual(await page.evaluate(() => window._columnData.quantile ?? null), quantiles);
                await scaleSelector.selectOption(mode === 'raw' ? 'linear' : 'raw');
                await page.waitForFunction(mode => new URL(location.href).searchParams.get('colourScale') === mode,
                    mode === 'raw' ? 'linear' : 'raw');
                await scaleSelector.selectOption(mode);
                await page.waitForFunction(mode => document.body.classList.contains('load-complete')
                    && new URL(location.href).searchParams.get('colourScale') === mode, mode);
                for (const key of Object.keys(flags)) assert.equal(new URL(page.url()).searchParams.has(key), false, 'Selector removes old keys');
                await page.locator('#settingsClose').click();
                assert.deepEqual(await page.evaluate(() => window._columnData.quantile ?? null), quantiles);
                assert(difference(await checkScaleColour(), pixels) <= 4, 'Canonical selector and legacy URL render identical pixels');
                await page.reload();
                await page.waitForFunction(() => document.body.classList.contains('load-complete') && window._columnData?.value[0] === 10);
                await page.locator('#settingsBtn').click();
                assert.equal(await scaleSelector.inputValue(), mode, 'Shared canonical URL restores selector');
                await page.locator('#settingsResetAll').click();
                await page.waitForFunction(() => document.body.classList.contains('load-complete')
                    && !new URL(location.href).searchParams.has('colourScale'));
                assert.equal(await scaleSelector.inputValue(), 'rankit', 'Global reset restores canonical dataset scale, not schema default or legacy metadata');
                assert.equal(new URL(page.url()).searchParams.has('t'), false);
            }
            routes.set('/data/scaling.json', scaleMetadata);
            await page.goto('about:blank');
            await page.goto(replayURL);
            await page.waitForFunction(() => document.body.classList.contains('load-complete') && window._columnData?.value[0] === 10);
            await page.locator('#settingsBtn').click();
            await scaleSelector.selectOption('rankit');
            await page.waitForFunction(() => new URL(location.href).searchParams.get('colourScale') === 'rankit'
                && document.body.classList.contains('load-complete')
                && window._columnData.quantile[0] === 0 && window._columnData.quantile[1] === 0.5);
            const rankitLegend = await page.locator('#observable_legend > :last-child').textContent();
            assert(rankitLegend.includes('10') && rankitLegend.includes('110'), `Rankit legend must use original units: ${rankitLegend}`);
            await page.locator('#settingsClose').click();
            await checkScaleColour();
            await page.reload();
            await page.waitForFunction(() => window._columnData?.value[0] === 10
                && document.body.classList.contains('load-complete')
                && window._columnData.quantile[0] === 0 && window._columnData.quantile[1] === 0.5);
            assert.equal(await page.locator('#observable_legend > :last-child').textContent(), rankitLegend, 'Shared rankit URL restores legend');
            await page.locator('#settingsBtn').click();
            await scaleSelector.selectOption('linear');
            await page.waitForFunction(() => new URL(location.href).searchParams.get('colourScale') === 'linear'
                && window._columnData?.quantile?.[1] === 0.1);
            assert.deepEqual(await page.evaluate(() => Array.from(window._columnData.quantile)), [0, 0.1, 1, 1], 'Linear replaces rankit and differs from uniform quantiles');
            const linearLegend = await page.locator('#observable_legend > :last-child').textContent();
            assert(linearLegend.includes('10') && linearLegend.includes('110'), `Linear legend uses visible original-unit endpoints: ${linearLegend}`);
            await page.getByRole('button', {name: 'Freeze legend', exact: true}).click();
            await page.waitForFunction(() => new URL(location.href).searchParams.get('legendBounds') === '[10,110]'
                && window._columnData.quantile[1] === 0.1);
            const legend = await page.locator('#observable_legend > :last-child').textContent();
            await page.locator('#settingsClose').click();
            await page.evaluate(() => m.jumpTo({zoom: 6.8}));
            assert.equal(await page.evaluate(() => window._columnData.quantile[1]), 0.1, 'Movement must not rerank frozen values');
            routes.set('/scaling-result', ['application/octet-stream', scaleResponse([35, 60, 210, 10000])]);
            await clickCell();
            await page.waitForFunction(() => window._columnData?.value[0] === 35 && window._columnData.quantile[0] === 0.25);
            assert.deepEqual(await page.evaluate(() => Array.from(window._columnData.quantile)), [0.25, 0.5, 1, 1]);
            await checkScaleColour();
            assert.equal(await page.locator('#observable_legend > :last-child').textContent(), legend, 'Click load must retain frozen legend');
            const sharedURL = page.url();
            await page.goto('about:blank');
            await page.goto(sharedURL);
            await page.waitForFunction(() => window._columnData?.value[0] === 35 && window._columnData.quantile[0] === 0.25);
            assert.equal(await page.locator('#observable_legend > :last-child').textContent(), legend, 'Shared URL must restore numeric bounds');
            await page.locator('#settingsBtn').click();
            await page.getByRole('button', {name: 'Unfreeze legend', exact: true}).click();
            await page.waitForFunction(() => new URL(location.href).searchParams.get('legendBounds') === 'null'
                && window._columnData.quantile[0] === 0 && window._columnData.quantile[1] === 1 / 7);
            await scaleSelector.selectOption('raw');
            await page.waitForFunction(() => new URL(location.href).searchParams.get('colourScale') === 'raw'
                && window._columnData?.value[0] === 35 && !window._columnData.quantile);
            await scaleSelector.selectOption('linear');
            await page.waitForFunction(() => window._columnData?.quantile?.[1] === 1 / 7);
            await scaleSelector.selectOption('rankit');
            await page.waitForFunction(() => window._columnData?.quantile?.[1] === 0.5);
            await scaleSelector.selectOption('quantile');
            await page.waitForFunction(() => new URL(location.href).searchParams.get('colourScale') === 'quantile'
                && Math.abs(window._columnData.quantile[0] - 1 / 3) < 1e-6);

            // Three visible rows: trim 0.34 selects the middle value at both ends, not min/max.
            const linearURL = new URL(page.url());
            linearURL.searchParams.delete('colourScale'); // Keep exercising shipped legacy URLs.
            for (const [key, value] of Object.entries({linear: '1', trimFactor: '0.34'})) linearURL.searchParams.set(key, value);
            await page.goto(linearURL.href);
            await page.waitForFunction(() => window._columnData?.quantile?.[1] === 0.5
                && document.body.classList.contains('load-complete'));
            await page.locator('#settingsBtn').click();
            await page.getByRole('button', {name: 'Freeze legend', exact: true}).click();
            await page.waitForFunction(() => new URL(location.href).searchParams.get('legendBounds') === '[60,60]');
            await page.getByRole('button', {name: 'Unfreeze legend', exact: true}).click();
            await page.locator('#settingsClose').click();
            await page.evaluate(() => m.jumpTo({center: [0, 25], zoom: 0}));
            await page.waitForFunction(() => window._columnData?.quantile?.[1] === 0
                && window._columnData.quantile[2] === 1);

            // Reuse the same replay fixture for weighted endpoints and finite/empty samples.
            linearURL.searchParams.set('trimFactor', '0.01');
            for (const [values, weights, expected] of [
                [[10, 20, 110, 10000], [0.001, 1, 0.001, 1], [0, 0.5, 1, 1]],
                [[10, 20, 110, 10000], [0, 0, 0, 0], [0, 0.1, 1, 1]],
                [[NaN, 7, Infinity, 10000], null, [null, 0.5, null, 1]],
                [[NaN, NaN, Infinity, NaN], null, [null, null, null, null]],
            ]) {
                routes.set('/scaling-result', ['application/octet-stream', scaleResponse(values, weights)]);
                await page.goto('about:blank');
                await page.goto(linearURL.href);
                await page.waitForFunction(expected => document.body.classList.contains('load-complete')
                    && JSON.stringify(window._columnData?.quantile) === JSON.stringify(expected), expected);
            }
            assert.equal(await page.locator('#observable_legend > :last-child .tick text').allTextContents().then(labels => labels.join('')), '', 'Empty sample has no numeric legend labels');
            routes.set('/scaling-result', ['application/octet-stream', scaleResponse([10, 20, 110, 10000])]);
            linearURL.searchParams.set('cartogram', 'selection_hilo.arrow');
            linearURL.searchParams.set('quantileSource', 'cartogram');
            linearURL.hash = '#x=0&y=0&z=7';
            await page.goto(linearURL.href);
            await page.waitForFunction(() => document.body.classList.contains('load-complete')
                && document.body.classList.contains('cartogram-ready') && window._columnData?.quantile?.[1] === 0.1);
            assert.deepEqual(await page.evaluate(() => Array.from(window._columnData.quantile)), [0, 0.1, 1, 1], 'Cartogram source overrides the distant visible map distribution');

            // Real Arrow aggregation: settings recompute, persist in shared URLs, and reset to metadata.
            await page.goto(`${origin}/?data=coverage.arrow#x=${center[0]}&y=${center[1]}&z=7`);
            const coverage = page.getByRole('checkbox', {name: 'Require complete coverage', exact: true});
            const coverageTooltip = async (row, expected) => {
                await page.waitForFunction(() => document.body.classList.contains('load-complete')
                    && document.body.classList.contains('cartogram-ready'));
                await settle(page);
                // Use the existing canvas hit test and tooltip, not a production test hook.
                await page.locator('#cartogram canvas').evaluate((canvas, row) => {
                    const rect = canvas.getBoundingClientRect(), scale = Math.min(rect.width / 45, rect.height / 35);
                    const [x, y] = canvas.__zoom.apply([
                        (rect.width - 45 * scale) / 2 + (12.5 + row * 10) * scale,
                        (rect.height - 35 * scale) / 2 + (row === 1 ? 22.5 : 12.5) * scale,
                    ]);
                    canvas.dispatchEvent(new MouseEvent('mouseleave'));
                    canvas.dispatchEvent(new MouseEvent('mousemove', {clientX: rect.x + x, clientY: rect.y + y, bubbles: true}));
                }, row);
                const tooltip = page.locator('.cartogram-tooltip');
                await tooltip.waitFor({state: 'visible'});
                const rows = await tooltip.locator('div').allTextContents();
                assert(rows.includes(`x: ${row * 2}`), `Tooltip must hit coverage row ${row}: ${rows}`);
                assert.equal(rows.find(text => text.startsWith('value_mean:')), expected === null ? undefined : `value_mean: ${expected}`);
                if (expected === null) assert(!rows.some(text => text.startsWith('carto_quantile:')), `Missing cell must stay missing: ${rows}`);
            };
            await coverageTooltip(0, 0.6);
            await page.locator('#settingsBtn').click();
            assert.equal(await coverage.isChecked(), false, 'Metadata defaults complete coverage off');
            await coverage.check();
            await page.waitForFunction(() => new URL(location.href).searchParams.get('requireCompleteCoverage') === '1');
            await coverageTooltip(0, null);
            await coverageTooltip(1, 0);
            for (const mode of ['raw', 'linear']) {
                await scaleSelector.selectOption(mode);
                await page.waitForFunction(raw => document.body.classList.contains('load-complete')
                    && (raw ? !window._columnData.quantile : new URL(location.href).searchParams.get('colourScale') === 'linear'
                        && window._columnData.quantile?.[0] === 1), mode === 'raw');
                await coverageTooltip(0, null);
                await coverageTooltip(1, 0);
            }
            const coverageURL = page.url();
            await page.goto('about:blank');
            await page.goto(coverageURL);
            await coverageTooltip(0, null);
            await page.reload();
            await coverageTooltip(0, null);
            await page.locator('#settingsBtn').click();
            assert.equal(await coverage.isChecked(), true, 'Shared URL and reload restore strict coverage');
            await page.locator('#settingsResetAll').click();
            await page.waitForFunction(() => !new URL(location.href).searchParams.has('requireCompleteCoverage'));
            assert.equal(await coverage.isChecked(), false, 'Reset restores metadata default');
            await coverageTooltip(0, 0.6);
            console.log(`${device}: complete coverage recomputation, colour modes, shared URL/reload and reset passed`);

            assert.equal(await page.getByRole('button', {name: 'Reset', exact: true}).count(), 1);
            assert.equal(await page.getByRole('button', {name: /^(Apply|Reset )/}).count(), 0);
            for (const size of [{width, height}, {width: height, height: width}]) {
                await page.setViewportSize(size);
                const fixed = await page.evaluate(() => {
                    const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
                    const fields = document.querySelector('#settingsFields');
                    fields.querySelectorAll('details').forEach(help => { help.open = true; });
                    fields.scrollTop = 0;
                    const before = ['.settings-panel-header', '.settings-actions'].map(rect);
                    fields.scrollTop = fields.scrollHeight;
                    return {before, after: ['.settings-panel-header', '.settings-actions'].map(rect),
                        scroll: fields.scrollTop, fields: rect('#settingsFields'),
                        shadows: ['#settingsBtn', '#helpBtn', '#city-search', '.request-spinner'].map(selector => getComputedStyle(document.querySelector(selector)).boxShadow),
                        progress: rect('#load-progress'), buttons: ['#settingsBtn', '#helpBtn', '#city-search'].map(rect)};
                });
                assert(fixed.scroll > 0, 'Fields scroll in both orientations');
                assert.deepEqual(fixed.after, fixed.before, 'Header and footer stay fixed while fields scroll');
                assert(fixed.fields.top >= fixed.before[0].bottom && fixed.fields.bottom <= fixed.before[1].top);
                assert(fixed.before[1].bottom <= size.height && fixed.before[0].top >= 0);
                assert(fixed.shadows[0] !== 'none' && fixed.shadows.every(shadow => shadow === fixed.shadows[0]), 'Utility buttons, search and request spinner share computed shadows');
                for (const button of fixed.buttons) assert(fixed.progress.bottom <= button.top || fixed.progress.top >= button.bottom
                    || fixed.progress.right <= button.left || fixed.progress.left >= button.right, 'Loading progress must not collide with controls');
                assert(fixed.progress.top >= fixed.buttons[0].bottom, 'Loading progress occupies a second row');
            }
            await page.locator('#settingsFields details').evaluateAll(helps => helps.forEach(help => { help.open = false; }));
            await page.setViewportSize({width, height});
            const trim = page.getByRole('spinbutton', {name: 'Trim fraction', exact: true});
            const cartogram = page.getByRole('textbox', {name: 'Cartogram weights', exact: true});
            const missing = page.getByRole('spinbutton', {name: 'Missing value', exact: true});
            await page.getByRole('checkbox', {name: 'Use Missing value', exact: true}).check();
            await page.waitForFunction(() => new URL(location.href).searchParams.get('defaultValue') === '0'
                && document.body.classList.contains('load-complete'));
            for (const [control, key, value] of [[trim, 'trimFactor', '0.1'], [cartogram, 'cartogram', 'selection_hilo.arrow'], [missing, 'defaultValue', '0.2']]) {
                const before = new URL(page.url()).searchParams.get(key);
                await control.fill(value);
                await new Promise(resolve => setTimeout(resolve, 200));
                assert.equal(new URL(page.url()).searchParams.get(key), before, `${key} waits for trailing debounce`);
                await control.fill(value);
                await new Promise(resolve => setTimeout(resolve, 200));
                assert.equal(new URL(page.url()).searchParams.get(key), before, `${key} restarts the trailing debounce on input`);
                await page.waitForFunction(([key, value]) => new URL(location.href).searchParams.get(key) === value
                    && document.body.classList.contains('load-complete'), [key, value]);
            }
            const requests = [];
            const record = request => requests.push(request.url());
            page.on('request', record);
            try {
                const before = page.url();
                await trim.fill('0.2');
                await trim.fill('0.8');
                await new Promise(resolve => setTimeout(resolve, 600));
                assert.equal(await trim.getAttribute('aria-invalid'), 'true');
                assert.equal(page.url(), before, 'Invalid input cancels the pending valid edit without URL changes');
                assert.deepEqual(requests, [], 'Invalid input cannot refetch data');
                await page.evaluate(() => { window.invalidMissingData = window._columnData; });
                await missing.press('ControlOrMeta+A');
                await missing.press('-');
                assert.equal(await missing.evaluate(input => input.validity.badInput), true, 'Real keyboard input produces badInput, not a sanitized empty fill');
                await new Promise(resolve => setTimeout(resolve, 600));
                assert.equal(await missing.getAttribute('aria-invalid'), 'true');
                assert.equal(page.url(), before, 'Enabled invalid Missing value must not commit null');
                assert.equal(await page.evaluate(() => window._columnData === window.invalidMissingData), true, 'Invalid Missing value must not rerender data');
                assert.deepEqual(requests, []);
                await missing.fill('0.4');
                await page.waitForFunction(() => new URL(location.href).searchParams.get('defaultValue') === '0.4'
                    && document.body.classList.contains('load-complete'));
                await missing.press('ControlOrMeta+A');
                await missing.press('-');
                await page.getByRole('checkbox', {name: 'Use Missing value', exact: true}).uncheck();
                await page.waitForFunction(() => new URL(location.href).searchParams.get('defaultValue') === 'null'
                    && document.body.classList.contains('load-complete'));
                assert.equal(await missing.isDisabled(), true);
                assert.equal(await missing.getAttribute('aria-invalid'), 'false', 'Disabled numeric validity cannot block disabling Missing value');
                await trim.fill('0.3');
                await cartogram.fill('must-not-request.arrow');
                await page.locator('#settingsResetAll').click();
                await page.waitForFunction(() => document.body.classList.contains('load-complete')
                    && !new URL(location.href).searchParams.has('trimFactor') && !new URL(location.href).searchParams.has('cartogram'));
                await new Promise(resolve => setTimeout(resolve, 600));
                assert.equal(await trim.inputValue(), '0');
                assert.equal(await cartogram.inputValue(), 'coverage-cartogram_hilo.arrow');
                assert.equal(await missing.isDisabled(), true);
                assert.equal(new URL(page.url()).searchParams.has('defaultValue'), false);
                assert(!requests.some(url => url.includes('must-not-request')), 'Reset cancels pending edits without reviving their requests');
                assert.equal(await trim.getAttribute('aria-invalid'), 'false');
            } finally {
                page.off('request', record);
            }
            await coverageTooltip(0, 0.6);
            await page.goto(`${origin}/?data=coverage.arrow&raw=true&trimFactor=0.2#x=${center[0]}&y=${center[1]}&z=7`);
            await coverageTooltip(0, 0.6);
            await page.locator('#settingsBtn').click();
            let held;
            await page.route('**/queued-cartogram_hilo.arrow', route => { held = route; });
            try {
                const requested = page.waitForRequest('**/queued-cartogram_hilo.arrow');
                await cartogram.fill('queued-cartogram_hilo.arrow');
                await requested;
                await page.locator('#settingsResetAll').click(); // This reset queues behind the in-flight load.
                const title = page.getByRole('textbox', {name: 'Title', exact: true});
                await title.fill('Obsolete queued title');
                await new Promise(resolve => setTimeout(resolve, 450)); // Let this commit queue behind the held cartogram load.
                assert.equal(new URL(page.url()).searchParams.has('t'), false);
                await page.locator('#settingsResetAll').click();
                await held.fulfill({contentType: 'application/octet-stream', body: routes.get('/data/selection_hilo.arrow')[1]});
                await page.waitForFunction(() => document.body.classList.contains('load-complete')
                    && !new URL(location.href).searchParams.has('cartogram'));
                await new Promise(resolve => setTimeout(resolve, 600));
                assert.equal(new URL(page.url()).searchParams.has('t'), false, 'Reset invalidates already queued commits');
                for (const key of ['raw', 'linear', 'rankit', 'colourScale', 'trimFactor', 'cartogram']) {
                    assert.equal(new URL(page.url()).searchParams.has(key), false, `Repeated reset must still clear ${key}`);
                }
                assert.equal(await scaleSelector.inputValue(), 'quantile');
                assert.equal(await title.inputValue(), '');
                assert.equal(await cartogram.inputValue(), 'coverage-cartogram_hilo.arrow');
                await coverageTooltip(0, 0.6);
            } finally {
                await page.unroute('**/queued-cartogram_hilo.arrow');
            }
            console.log(`${device}: fixed settings layout, shared shadows, validated trailing auto-apply and reset cancellation passed`);
            await page.setViewportSize({width: height, height: width});

            // Selection is independent of scaling and camera focus, in both panes.
            for (const [focus, highlight] of [[false, true], [true, false]]) {
                routes.set('/data/selection.json', ['application/json', JSON.stringify({
                    cartogram: 'selection_hilo.arrow', raw: true, crosshair: false, // Keep origin-marker pixel samples unobscured.
                    t: 'From {TOWN_NAME}',
                    onclick: {url: '/selection-result?index={index}', focus, highlight},
                    onmove: {url: '/selection-result?index={index}', wait: 0},
                })]);
                let pending, receive;
                const nextRequest = () => new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('Selection request was not routed')), 20000);
                    receive = () => { clearTimeout(timer); resolve(); };
                });
                await page.route('**/selection-result?*', route => { pending = route; receive?.(); });
                await page.goto(`${origin}/?data=selection.csv#x=${center[0]}&y=${center[1]}&z=7`);
                await page.waitForFunction(() => document.body.classList.contains('load-complete')
                    && document.body.classList.contains('cartogram-ready'));
                await settle(page);
                const camera = () => page.evaluate(() => [m.getCenter().lng, m.getCenter().lat, m.getZoom(), m.getBearing(), m.getPitch()]);
                const marker = () => page.evaluate(() => m._controls.find(control => control.getCanvas?.()?.id === 'deckgl-overlay')
                    ._deck.props.layers.find(layer => layer.id === 'hex-highlight')?.props.data || []);
                const checkTitle = async expected => {
                    assert.equal(await page.title(), expected, 'Browser title follows displayed result');
                    assert.equal(await page.locator('#observable_legend > :last-child .title').textContent(), expected);
                };
                const queryCity = () => {
                    const query = JSON.parse(new URL(page.url()).searchParams.get('query'));
                    return findClosestCity(query.lat, query.lng).name;
                };
                await checkTitle('From {TOWN_NAME}');
                const cartoPoint = row => page.evaluate(row => {
                    const canvas = document.querySelector('#cartogram canvas'), rect = canvas.getBoundingClientRect();
                    const scale = Math.min(rect.width / 45, rect.height / 35);
                    const [x, y] = canvas.__zoom.apply([
                        (rect.width - 45 * scale) / 2 + (12.5 + row * 10) * scale,
                        (rect.height - 35 * scale) / 2 + (row === 1 ? 22.5 : 12.5) * scale,
                    ]);
                    return {x: rect.x + x, y: rect.y + y};
                }, row);
                const cartoMarked = () => page.evaluate(() => {
                    const canvas = document.querySelector('#cartogram canvas');
                    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
                    for (let i = 0; i < pixels.length; i += 4) {
                        if (pixels[i] > 240 && pixels[i + 1] > 140 && pixels[i + 1] < 190 && pixels[i + 2] < 20) return true;
                    }
                    return false;
                });
                const clickOrigin = async (index = cell) => {
                    const request = nextRequest();
                    await clickCell(index);
                    await request;
                };
                const respond = async (value, fail = false) => {
                    assert(pending, 'Click must issue a request');
                    await pending.fulfill({status: fail ? 503 : 200, contentType: 'application/octet-stream',
                        body: fail ? 'selection-test-failure' : scaleResponse([value, 0.5, 0.8, 1])});
                    await page.waitForFunction(({value, fail}) => fail ? document.body.classList.contains('load-error')
                        : document.body.classList.contains('load-complete') && window._columnData?.value[0] === value, {value, fail});
                    await settle(page);
                };
                const before = await camera();
                await clickOrigin();
                assert.deepEqual(await marker(), [], 'Pending first query has no marker');
                await checkTitle('From {TOWN_NAME}');
                const firstCity = queryCity();
                await respond(0.2);
                await checkTitle(`From ${firstCity}`);
                assert.deepEqual(await marker(), highlight ? [cell] : []);
                assert.equal(await cartoMarked(), highlight, 'Geographic selection marks linked cartogram square');
                if (!focus) assert.deepEqual(await camera(), before, 'Highlight must not move camera');
                if (highlight) {
                    const point = await page.evaluate(center => {
                        const p = m.project(center), rect = m.getCanvas().getBoundingClientRect();
                        return [rect.x + p.x, rect.y + p.y];
                    }, center);
                    assert(difference(rgb(PNG.sync.read(await page.screenshot({scale: 'css'})), point), [24, 0, 0]) <= 4,
                        'Origin marker must be visible in rendered map pixels');
                }

                await clickOrigin(scaleCells[2]);
                const obsolete = pending;
                await settle(page);
                assert.deepEqual(await marker(), highlight ? [cell] : [], 'Pending geographic click retains displayed origin');
                await checkTitle(`From ${firstCity}`);

                const point = await cartoPoint(1);
                const request = nextRequest();
                await page.mouse.click(point.x, point.y);
                await request;
                assert.deepEqual(await marker(), highlight ? [cell] : [], 'Pending cartogram click retains displayed origin');
                await respond(0.3, true);
                await obsolete.fulfill({contentType: 'application/octet-stream', body: scaleResponse([0.9, 0.5, 0.8, 1])});
                await settle(page);
                assert.equal(await page.evaluate(() => window._columnData.value[0]), 0.2, 'Superseded response cannot replace displayed result');
                assert.deepEqual(await marker(), highlight ? [cell] : [], 'Failed click retains displayed origin');
                await checkTitle(`From ${firstCity}`);
                await page.locator('#settingsBtn').click();
                const titleInput = page.getByRole('textbox', {name: 'Title', exact: true});
                assert.equal(await titleInput.inputValue(), 'From {TOWN_NAME}', 'Settings retain template');
                await titleInput.fill('Plain title');
                await titleInput.blur();
                await page.waitForFunction(() => document.title === 'Plain title');
                await checkTitle('Plain title');
                await titleInput.fill('Edited {TOWN_NAME}');
                await titleInput.blur();
                await page.waitForFunction(() => new URL(location.href).searchParams.get('t') === 'Edited {TOWN_NAME}');
                await checkTitle(`Edited ${firstCity}`);
                await page.locator('#settingsClose').click();
                assert.equal(await cartoMarked(), highlight, 'Failure retains cartogram selection');
                if (!focus) assert.deepEqual(await camera(), before);
                else assert.notDeepEqual(await camera(), before, 'Focus works with highlighting disabled');

                const retry = nextRequest();
                await page.getByRole('button', {name: 'Retry', exact: true}).click();
                await retry;
                await respond(0.4);
                const secondCity = queryCity();
                await checkTitle(`Edited ${secondCity}`);
                assert.deepEqual(await marker(), highlight ? [scaleCells[1]] : [], 'Retry selects successful cartogram origin');
                assert.equal(await cartoMarked(), highlight);
                const savedCamera = await camera();
                const replay = nextRequest();
                const shared = new URL(page.url());
                shared.searchParams.set('onclick', 'false');
                await page.goto(shared.href);
                await replay;
                assert.deepEqual(await marker(), [], 'Replay does not mark an undisplayed result');
                assert.equal(await page.title(), 'Edited {TOWN_NAME}', 'Replay waits for displayed result');
                await respond(0.6);
                await checkTitle(`Edited ${secondCity}`);
                assert.deepEqual(await marker(), highlight ? [scaleCells[1]] : [], 'Shared URL restores selection even with automatic clicks disabled');
                assert.equal(await cartoMarked(), highlight);
                assert(difference(await camera(), savedCamera) < 0.001, 'Replay preserves camera');
                if (highlight) {
                    await page.locator('#settingsBtn').click();
                    const refresh = nextRequest();
                    await scaleSelector.selectOption('quantile');
                    await refresh;
                    await respond(0.7);
                    await page.waitForFunction(() => document.body.classList.contains('load-complete') && window._columnData?.quantile);
                    assert.deepEqual(await marker(), [scaleCells[1]], 'Settings refresh retains displayed selection');
                    assert.equal(await cartoMarked(), true);
                    await checkTitle(`Edited ${secondCity}`);
                    await page.locator('#settingsClose').click();
                }

                const moveRequest = nextRequest();
                await page.evaluate(() => {
                    m.jumpTo({center: [139.75, 35.68]});
                    // Exercise the application's user-movement delivery, without a long pan across the globe.
                    m.fire('movestart', {keyboardMoving: true});
                    m.fire('moveend');
                });
                await moveRequest;
                await checkTitle(`Edited ${secondCity}`);
                assert.deepEqual(await marker(), highlight ? [scaleCells[1]] : [], 'Pending move retains click marker');
                const moveCity = queryCity();
                assert.notEqual(moveCity, secondCity, 'Movement must test a different city');
                await respond(0.8, true);
                await checkTitle(`Edited ${secondCity}`);
                assert.deepEqual(await marker(), highlight ? [scaleCells[1]] : [], 'Failed move retains click marker');
                const moveRetry = nextRequest();
                await page.getByRole('button', {name: 'Retry', exact: true}).click();
                await moveRetry;
                await respond(0.8);
                await checkTitle(`Edited ${moveCity}`);
                assert.deepEqual(await marker(), [], 'Successful movement clears click marker');
                assert.equal(await cartoMarked(), false);
                const moveReplay = nextRequest();
                await page.reload();
                await moveReplay;
                assert.equal(await page.title(), 'Edited {TOWN_NAME}');
                await respond(0.9);
                await checkTitle(`Edited ${moveCity}`);
                assert.deepEqual(await marker(), [], 'Movement replay has no click marker');
                await page.unroute('**/selection-result?*');

                if (highlight) {
                    routes.set('/data/selection.json', ['application/json', JSON.stringify({
                        cartogram: 'selection_hilo.arrow', raw: true, t: 'Static {TOWN_NAME}', onclick: false,
                    })]);
                    await page.goto(`${origin}/?data=selection.csv#x=${center[0]}&y=${center[1]}&z=7`);
                    await page.waitForFunction(() => document.body.classList.contains('load-complete')
                        && document.body.classList.contains('cartogram-ready'));
                    await checkTitle('Static {TOWN_NAME}');
                    await clickCell();
                    await settle(page);
                    await checkTitle(`Static ${findClosestCity(center[1], center[0]).name}`);
                    assert.deepEqual(await marker(), [cell]);
                    const point = await cartoPoint(1);
                    await page.mouse.click(point.x, point.y);
                    await settle(page);
                    await checkTitle(`Static ${findClosestCity(...cellToLatLng(scaleCells[1])).name}`);
                    assert.deepEqual(await marker(), [scaleCells[1]]);
                    assert.equal(new URL(page.url()).searchParams.has('query'), false, 'Static selection needs no query');
                    await page.goto('about:blank');
                }
            }
            // Real browser WebSockets, controlled server replies, and the normal app render lane.
            const sockets = [], queries = [];
            let streaming = false;
            const reply = (request, value, malformed = false) => {
                const id = Buffer.alloc(4);
                id.writeUInt32BE(request.id);
                request.socket.send(Buffer.concat([id, malformed ? Buffer.from('invalid-arrow')
                    : scaleResponse([value, value + 10, value + 100, 10000])]));
            };
            await page.routeWebSocket('**/query-stream', socket => {
                sockets.push(socket);
                socket.onMessage(message => {
                    const query = JSON.parse(String(message));
                    assert.equal(query.type, 'query');
                    assert(query.url.startsWith('/socket-result?'), 'Send only the resolved path and search');
                    queries.push({...query, socket});
                    if (streaming) reply(queries.at(-1), 35);
                });
            });
            const received = async count => {
                const deadline = Date.now() + 20000;
                while (queries.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
                assert.equal(queries.length, count, 'Expected exactly one query per changed interaction');
                return queries.at(-1);
            };
            const displayed = async value => {
                await page.waitForFunction(value => window._columnData?.value[0] === value
                    && document.body.classList.contains('load-complete'), value);
                await settle(page);
            };
            const retained = async value => {
                await settle(page);
                assert.equal(await page.evaluate(() => window._columnData.value[0]), value, 'Stale or malformed reply must retain displayed data');
            };
            const move = async (count = 1) => {
                const expected = queries.length + count;
                await page.evaluate(count => {
                    for (let i = 0; i < count; i++) {
                        m.jumpTo({center: [m.getCenter().lng + 0.001, m.getCenter().lat]});
                        m.fire('movestart', {keyboardMoving: true});
                        m.fire('move');
                        m.fire('moveend');
                    }
                }, count);
                return received(expected);
            };
            const socketAction = {url: '/socket-result?index={index}&lng={lng}',
                socket: origin.replace('http:', 'ws:') + '/query-stream', wait: 0, focus: false};
            routes.set('/data/socket.csv', routes.get('/data/scaling.csv'));
            routes.set('/data/socket.json', ['application/json', JSON.stringify({cartogram: 'none', trimFactor: 0,
                onclick: socketAction, onmove: socketAction})]);
            await page.goto(`${origin}/?data=socket.csv#x=${center[0]}&y=${center[1]}&z=7`);
            await displayed(1);
            await clickCell();
            const first = await received(1);
            reply(first, 10);
            await displayed(10);
            await clickCell(scaleCells[1]);
            await received(2);
            await clickCell(scaleCells[2]);
            const clicked = await received(3);
            reply(queries[1], 99);
            await retained(10);
            reply(clicked, 20);
            await displayed(20);
            await move(3);
            const [older, trailing, newest] = queries.slice(-3);
            reply(trailing, 30);
            await displayed(30); // A newer request is on wire, not yet answered.
            reply(older, 98);
            await retained(30);
            reply(newest, 40);
            await displayed(40);
            assert.equal(sockets.length, 1, 'Clicks and rapid wait:0 moves reuse one connection');

            const invalidated = await move();
            const explicitCount = queries.length + 1;
            await clickCell();
            const explicit = await received(explicitCount);
            reply(invalidated, 97);
            await retained(40);
            reply(explicit, 50);
            await displayed(50);
            const bad = await move();
            reply(bad, 0, true);
            await page.waitForFunction(() => document.body.classList.contains('load-error'));
            await retained(50);
            const retryCount = queries.length + 1;
            await page.getByRole('button', {name: 'Retry', exact: true}).click();
            const retried = await received(retryCount);
            assert.equal(retried.url, bad.url, 'Retry resubmits the failed origin');
            reply(retried, 60);
            await displayed(60);

            await move(3);
            const latest = queries.at(-1), reconnectCount = queries.length + 1;
            await sockets[0].close({code: 1011, reason: 'controlled disconnect'});
            const reconnected = await received(reconnectCount);
            assert.equal(sockets.length, 2);
            assert.equal(reconnected.url, latest.url, 'Reconnect replays only the latest outstanding query');
            reply(reconnected, 70);
            await displayed(70);
            assert.equal(queries.length, reconnectCount, 'Reconnect must not replay the backlog');

            const shared = new URL(page.url()), replayCount = queries.length + 1;
            shared.searchParams.set('onmove', 'false');
            await page.goto(shared.href);
            const replayed = await received(replayCount);
            assert.equal(replayed.url, latest.url, 'Shared URL replays socket query with automatic moves disabled');
            reply(replayed, 10);
            await displayed(10);

            // Simulate bfcache lifecycle events; routing does not prove actual bfcache eligibility.
            const hideCount = queries.length + 1;
            await clickCell();
            const suspended = await received(hideCount), socketCount = sockets.length;
            let closed = false;
            suspended.socket.onClose(() => { closed = true; });
            await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true})));
            // Longer than the first reconnect delay: suspension must not reconnect itself.
            await new Promise(resolve => setTimeout(resolve, 350));
            assert(closed, 'Persisted pagehide closes the query connection');
            assert.equal(sockets.length, socketCount, 'Suspension must not reconnect');
            assert.equal(queries.length, hideCount, 'Suspension must not replay queries');
            await retained(10);
            await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true})));
            const restored = await received(hideCount + 1);
            assert.equal(sockets.length, socketCount + 1, 'Persisted pageshow opens a fresh connection');
            assert.notEqual(restored.socket, suspended.socket);
            assert.equal(restored.url, suspended.url, 'Restore replays the pending origin');
            reply(restored, 15);
            await displayed(15);
            const afterRestoreCount = queries.length + 1;
            await clickCell(scaleCells[1]);
            const afterRestore = await received(afterRestoreCount);
            assert.equal(afterRestore.socket, restored.socket, 'Interactions reuse the restored connection');
            reply(afterRestore, 25);
            await displayed(25);

            shared.searchParams.delete('onmove');
            const enabledCount = queries.length + 1;
            await page.goto(shared.href);
            reply(await received(enabledCount), 10);
            await displayed(10);
            await page.locator('#settingsBtn').click();
            streaming = true;
            await page.evaluate(() => {
                window.socketTestTraffic = setInterval(() => {
                    m.jumpTo({center: [m.getCenter().lng + 0.0001, m.getCenter().lat]});
                    m.fire('movestart', {keyboardMoving: true});
                    m.fire('move');
                    m.fire('moveend');
                }, 40);
            });
            try {
                await scaleSelector.selectOption('rankit');
                await page.waitForFunction(() => new URL(location.href).searchParams.get('colourScale') === 'rankit'
                    && window._columnData?.value[0] === 35 && window._columnData.quantile[1] === 0.5);
                const visibleBounds = await page.getByRole('button', {name: 'Freeze legend', exact: true}).evaluate(button => {
                    const ticks = [...document.querySelectorAll('#observable_legend > :last-child .tick')];
                    const endpoints = [ticks[0], ticks.at(-1)].map(tick => ({value: tick.__data__, text: tick.textContent}));
                    button.click(); // Capture the published legend and click without an intervening result.
                    return endpoints;
                });
                assert.deepEqual(visibleBounds.map(tick => tick.value), [0, 1], 'Legend ticks include both scale endpoints');
                await page.waitForFunction(() => new URL(location.href).searchParams.has('legendBounds'));
                const frozenBounds = JSON.parse(new URL(page.url()).searchParams.get('legendBounds'));
                assert.deepEqual(frozenBounds.map(value => Number(value.toPrecision(2)).toLocaleString()),
                    visibleBounds.map(tick => tick.text), 'Freeze captures the published legend, not an in-flight scale');
                await page.waitForFunction(([min, max]) => Math.abs(window._columnData.quantile[1]
                    - Math.max(0, Math.min(1, (45 - min) / (max - min)))) < 1e-6, frozenBounds);
                await page.waitForFunction(() => window._columnData?.value[0] === 35
                    && document.body.classList.contains('load-complete'));
                assert(queries.length > enabledCount + 1, 'Settings must finish while multiple results are arriving');
            } finally {
                await page.evaluate(() => clearInterval(window.socketTestTraffic));
                streaming = false;
            }
            console.log(`${device}: persistent WebSocket regressions passed`);

            // The same result-title lifecycle must use raw controls on HTTP and socket transports.
            for (const transport of ['http', 'socket']) {
                const pending = [];
                const note = `${transport === 'http' ? 'An ordinary long place name with many words '.repeat(3).trim() : 'N'.repeat(150)} <b>literal</b> {controls.time}/{index}/{TOWN_NAME}`;
                const template = 'From {TOWN_NAME} | {controls.time} min at {controls.departure} | {index}/{index_lower}/{index_upper} | {lat},{lng}@{zoom} | {controls.note} | {unknown} {controls.missing}';
                const controls = {
                    time: {label: 'Travel time', type: 'number', default: 360, min: 0, encode: 'value => value * 60'},
                    departure: {label: 'Departure', type: 'time', default: '08:00', encode: 'value => Number(value.slice(0, 2)) + Number(value.slice(3, 5)) / 60'},
                    note: {label: 'Note', type: 'text', default: note},
                };
                const action = {url: '/selection-result?index={index}&time={controls.time}&departure={controls.departure}',
                    focus: false, highlight: false,
                    ...(transport === 'socket' ? {socket: origin.replace('http:', 'ws:') + '/title-stream'} : {})};
                routes.set('/data/socket.json', ['application/json', JSON.stringify({cartogram: 'none', trimFactor: 0,
                    t: template, controls, onclick: action})]);
                if (transport === 'http') {
                    await page.route('**/selection-result?*', route => pending.push({url: route.request().url(),
                        respond: (value, fail) => route.fulfill({status: fail ? 503 : 200, contentType: 'application/octet-stream',
                            body: fail ? 'selection-test-failure' : scaleResponse([value, 20, 110, 10000])})}));
                } else {
                    await page.routeWebSocket('**/title-stream', socket => socket.onMessage(message => {
                        const query = JSON.parse(String(message));
                        pending.push({url: query.url, respond: (value, fail) => {
                            const id = Buffer.alloc(4);
                            id.writeUInt32BE(query.id);
                            socket.send(Buffer.concat([id, fail ? Buffer.from('invalid-arrow') : scaleResponse([value, 20, 110, 10000])]));
                        }});
                    }));
                }
                const receivedTitle = async (count, time, departure) => {
                    const deadline = Date.now() + 20000;
                    while (pending.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
                    assert.equal(pending.length, count, `${transport}: exactly one request per trailing edit`);
                    const request = pending.at(-1), params = new URL(request.url, origin).searchParams;
                    assert.equal(params.get('time'), String(time * 60), 'Request uses converted seconds');
                    assert.equal(params.get('departure'), String(Number(departure.slice(0, 2)) + Number(departure.slice(3, 5)) / 60), 'Request uses converted hours');
                    const saved = new URL(page.url()).searchParams, query = JSON.parse(saved.get('query'));
                    assert.equal(saved.get('p.time'), String(time), 'Shared URL retains raw numeric input');
                    assert.equal(saved.get('p.departure'), departure, 'Shared URL retains raw time string');
                    const [lower, upper] = h3IndexToSplitLong(query.index);
                    request.title = `From ${findClosestCity(query.lat, query.lng).name} | ${time} min at ${departure} | ${query.index}/${lower >>> 0}/${upper >>> 0} | ${query.lat},${query.lng}@${query.zoom} | ${note} | {unknown} {controls.missing}`;
                    return request;
                };
                const checkTitle = async expected => {
                    assert.equal(await page.title(), expected, `${transport}: title uses the displayed query's raw inputs and builtins`);
                    assert.equal(await page.locator('#observable_legend > :last-child .title').textContent(), expected);
                    await page.waitForFunction(() => document.querySelector('#observable_legend').childElementCount === 1);
                    const geometry = await page.locator('#observable_legend > :last-child').evaluate(entry => {
                        const title = entry.querySelector('div.title'), svg = entry.querySelector('svg');
                        const range = document.createRange();
                        range.selectNodeContents(title);
                        const lines = [...range.getClientRects()];
                        return {lines: new Set(lines.map(rect => rect.top)).size, widths: lines.map(rect => rect.width),
                            bounds: [entry, title, svg, document.querySelector('#attribution')]
                                .map(element => element.getBoundingClientRect().toJSON()).concat(lines.map(rect => rect.toJSON())),
                            titleBottom: title.getBoundingClientRect().bottom, barTop: svg.getBoundingClientRect().top,
                            markup: title.childElementCount, svgTitles: svg.querySelectorAll('.title').length};
                    });
                    assert(geometry.lines >= 2, `${transport}: long title wraps onto multiple lines`);
                    assert(geometry.bounds.every(rect => rect.width > 0 && rect.left >= -1 && rect.right <= page.viewportSize().width + 1),
                        `${transport}: title text, entry, bar and attribution stay horizontally on screen`);
                    assert(geometry.barTop >= geometry.titleBottom, `${transport}: bar stays below the title without overlap`);
                    assert.equal(geometry.markup, 0, 'HTML and braces remain literal title text');
                    assert.equal(geometry.svgTitles, 0, 'SVG must not duplicate the HTML title');
                    return geometry.widths;
                };
                await page.goto('about:blank');
                await page.goto(`${origin}/?data=socket.csv#x=${center[0]}&y=${center[1]}&z=7`);
                await displayed(1);
                await checkTitle(template);
                await clickCell();
                const first = await receivedTitle(1, 360, '08:00');
                await checkTitle(template);
                const previousEntry = await page.locator('#observable_legend > :last-child').elementHandle();
                await first.respond(10);
                await displayed(10);
                await checkTitle(first.title);
                assert.equal(await previousEntry.evaluate(entry => entry.isConnected), false, 'Transition replaces the whole legend entry');
                await previousEntry.dispose();
                const resizeRequests = [], lineWidths = [];
                const recordResize = request => resizeRequests.push(request.url());
                const originalSize = page.viewportSize();
                page.on('request', recordResize);
                try {
                    for (const width of [1200, 375, 320, 1200]) {
                        await page.setViewportSize({width, height: originalSize.height});
                        await settle(page);
                        lineWidths.push(await checkTitle(first.title));
                    }
                    assert.notDeepEqual(lineWidths[2], lineWidths[0], 'Narrow viewport naturally changes title wrapping');
                    assert.deepEqual(lineWidths[3], lineWidths[0], 'Widening restores the original wrapping');
                    assert.deepEqual(resizeRequests, [], 'Legend resize needs no HTTP requests');
                    assert.equal(pending.length, 1, 'Legend resize needs no socket queries');
                } finally {
                    page.off('request', recordResize);
                    await page.setViewportSize(originalSize);
                }
                await page.locator('#settingsBtn').click();
                const time = page.getByRole('spinbutton', {name: 'Travel time', exact: true});
                const departure = page.getByLabel('Departure', {exact: true});
                const title = page.getByRole('textbox', {name: 'Title', exact: true});
                await time.fill('480');
                await departure.fill('09:30');
                const edited = await receivedTitle(2, 480, '09:30');
                await checkTitle(first.title);
                await title.fill(`Edited ${template}`);
                await edited.respond(0, true);
                await page.waitForFunction(() => document.body.classList.contains('load-error'));
                await page.waitForFunction(template => new URL(location.href).searchParams.get('t') === `Edited ${template}`, template);
                await checkTitle(`Edited ${first.title}`); // Latest controls are 480/09:30; displayed controls are still 360/08:00.
                assert.equal(await page.evaluate(() => window._columnData.value[0]), 10);
                await page.locator('#settingsClose').click();
                await page.getByRole('button', {name: 'Retry', exact: true}).click();
                const retried = await receivedTitle(3, 480, '09:30');
                assert.equal(retried.url, edited.url);
                await retried.respond(12);
                await displayed(12);
                await checkTitle(`Edited ${retried.title}`);
                await page.locator('#settingsBtn').click();
                await scaleSelector.selectOption('linear');
                // HTTP refresh refetches its accepted source; socket refresh can reuse accepted bytes.
                if (transport === 'http') await (await receivedTitle(4, 480, '09:30')).respond(12);
                await page.waitForFunction(() => document.body.classList.contains('load-complete') && window._columnData?.quantile?.[1] === 8 / 98);
                await checkTitle(`Edited ${retried.title}`);
                const replayCount = pending.length + 1;
                const titleURL = new URL(page.url());
                titleURL.searchParams.delete('colourScale'); // Isolate request-reset coalescing from a separate data refresh.
                await page.goto(titleURL.href);
                const replayed = await receivedTitle(replayCount, 480, '09:30');
                assert.equal(await page.title(), `Edited ${template}`, 'Replay leaves the title unresolved until its first result');
                await replayed.respond(14);
                await displayed(14);
                await checkTitle(`Edited ${replayed.title}`);
                await page.locator('#settingsBtn').click();
                const resetCount = pending.length + 1;
                await page.evaluate(() => {
                    document.querySelector('#settingsResetAll').click();
                    const title = document.querySelector('#setting-t');
                    title.value = 'Must not survive repeated reset';
                    title.dispatchEvent(new Event('input', {bubbles: true}));
                    document.querySelector('#settingsResetAll').click();
                });
                const reset = await receivedTitle(resetCount, 360, '08:00');
                await reset.respond(16);
                await displayed(16);
                await new Promise(resolve => setTimeout(resolve, 600));
                assert.equal(pending.length, resetCount, 'Repeated reset within 350ms coalesces request defaults');
                for (const key of ['t', 'colourScale', 'raw', 'trimFactor']) assert.equal(new URL(page.url()).searchParams.has(key), false);
                assert.equal(await time.inputValue(), '360');
                assert.equal(await departure.inputValue(), '08:00');
                assert.equal(await scaleSelector.inputValue(), 'quantile');
                await checkTitle(reset.title);
                if (transport === 'http') await page.unroute('**/selection-result?*');
                console.log(`${device}: ${transport} raw-control/builtin titles, pending edits, failure/retry, refresh/replay and repeated request reset passed`);
            }
        } catch (error) {
            console.error(await page.evaluate(() => ({classes: document.body.className,
                status: document.querySelector('#request-status pre')?.textContent,
                url: location.href, values: Array.from(window._columnData?.value || []),
                quantiles: Array.from(window._columnData?.quantile || []),
                columns: Object.keys(window._columnData || {}), loaded: window.m?.loaded()})));
            failures.push(`${device}: ${error.stack || error}`);
        } finally {
            await context.close();
        }
    }
} finally {
    try { await browser?.close(); }
    finally { await new Promise(resolve => server.close(resolve)); }
}
if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
} else {
    console.log('Rendering regressions passed: desktop/mobile, cameras, panes, orientation, linear, rankit, frozen bounds, raw mode, independent selection, nearest-city titles and persistent WebSocket transport.');
}
