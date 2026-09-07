import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {PNG} from 'pngjs';
import {cellToBoundary, cellToLatLng, gridDisk, h3IndexToSplitLong, latLngToCell} from 'h3-js';
import {tableFromArrays, tableToIPC} from 'apache-arrow';
import {findClosestCity} from 'tiny-geocoder';

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
const scaleResponse = values => Buffer.from(tableToIPC(tableFromArrays({
    index_lower: Uint32Array.from(scaleCells, index => h3IndexToSplitLong(index)[0]),
    index_upper: Uint32Array.from(scaleCells, index => h3IndexToSplitLong(index)[1]),
    value: Float64Array.from(values),
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
            };
            await clickCell();
            await page.waitForFunction(() => window._columnData?.value[0] === 10
                && Math.abs(window._columnData.quantile[0] - 1 / 3) < 1e-6);
            await checkScaleColour();
            await page.locator('#settingsBtn').click();
            await page.getByRole('checkbox', {name: 'Rankit colours', exact: true}).check();
            await page.waitForFunction(() => new URL(location.href).searchParams.get('rankit') === '1'
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
                && window._columnData.quantile[0] === 0 && window._columnData.quantile[1] === 0.5);
            await page.getByRole('checkbox', {name: 'Raw values', exact: true}).check();
            await page.waitForFunction(() => new URL(location.href).searchParams.get('raw') === '1'
                && window._columnData?.value[0] === 35 && !window._columnData.quantile);
            await page.getByRole('checkbox', {name: 'Raw values', exact: true}).uncheck();
            await page.waitForFunction(() => window._columnData?.quantile?.[1] === 0.5);
            await page.getByRole('checkbox', {name: 'Rankit colours', exact: true}).uncheck();
            await page.waitForFunction(() => new URL(location.href).searchParams.get('rankit') === '0'
                && Math.abs(window._columnData.quantile[0] - 1 / 3) < 1e-6);

            // Selection is independent of scaling and camera focus, in both panes.
            for (const [focus, highlight] of [[false, true], [true, false]]) {
                routes.set('/data/selection.json', ['application/json', JSON.stringify({
                    cartogram: 'selection_hilo.arrow', raw: true,
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
                    await page.getByRole('checkbox', {name: 'Raw values', exact: true}).uncheck();
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
        } catch (error) {
            console.error(await page.evaluate(() => ({classes: document.body.className,
                status: document.querySelector('#request-status pre')?.textContent,
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
    console.log('Rendering regressions passed: desktop/mobile, cameras, panes, orientation, rankit, frozen bounds, raw mode, independent selection and nearest-city titles (click, cartogram, movement, replay, edits and static selection).');
}
