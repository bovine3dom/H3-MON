import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {PNG} from 'pngjs';
import {cellToBoundary, cellToLatLng, gridDisk, h3IndexToSplitLong, latLngToCell} from 'h3-js';
import {tableFromArrays, tableToIPC} from 'apache-arrow';
import {findClosestCity} from 'tiny-geocoder';

// Serve the real build and deterministic fixtures, never local user data or a replacement Deck layer.
const cell = '851fb467fffffff', center = cellToLatLng(cell).reverse(), boundary = cellToBoundary(cell, true);
const cells = [cell, ...gridDisk(cell, 1).filter(index => index !== cell).slice(0, 2), latLngToCell(0, 0, 5)];
const columns = {
    index_lower: Uint32Array.from(cells, index => h3IndexToSplitLong(index)[0]),
    index_upper: Uint32Array.from(cells, index => h3IndexToSplitLong(index)[1]),
};
const arrow = data => Buffer.from(tableToIPC(tableFromArrays(data)));
const values = value => arrow({...columns, value: Float64Array.from([value, 20, 110, 10000])});
const background = '#5890aa';
const style = {
    version: 8, transition: {duration: 0, delay: 0},
    sources: {reference: {type: 'geojson', data: {type: 'FeatureCollection',
        features: [boundary, [[center[0] - 0.4, center[1]], [center[0] + 0.4, center[1]]],
            [[center[0], center[1] - 0.3], [center[0], center[1] + 0.3]]].map(coordinates => ({
            type: 'Feature', properties: {}, geometry: {type: 'LineString', coordinates},
        })),
    }}},
    layers: [{id: 'background', type: 'background', paint: {'background-color': background}},
        {id: 'reference', type: 'line', source: 'reference', paint: {'line-color': '#18303c', 'line-width': 2}}],
};
const routes = new Map();
const json = (path, data) => routes.set(path, ['application/json', JSON.stringify(data)]);
json('/toner_ofm_moderatlist.json', style);
json('/data/rendering.json', {cartogram: 'none', raw: true, colourScheme: 'interpolateReds'});
json('/data/settings.json', {cartogram: 'none', colourScale: 'rankit', trimFactor: 0});
json('/data/coverage.json', {cartogram: 'coverage-cartogram_hilo.arrow', requireCompleteCoverage: false, trimFactor: 0});
routes.set('/data/coverage.arrow', ['application/octet-stream', arrow({...columns, value: Float64Array.from([0.6, NaN, 0, 0.8])})]);
routes.set('/data/coverage-cartogram_hilo.arrow', ['application/octet-stream', arrow({...columns,
    x: Int32Array.from([0, 0, 2, 4]), y: Int32Array.from([0, 0, 2, 0]),
    code: Int32Array.from([100, 100, 100, 100]), weight: Float64Array.from([1, 1, 1, 1]),
})]);
routes.set('/data/settings.arrow', ['application/octet-stream', values(10)]);
for (const name of ['rendering', 'query']) routes.set(`/data/${name}.csv`, ['text/csv', `index,value\n${cell},0.65\n`]);
for (const [name, type] of [['index.html', 'text/html'], ['app.js', 'text/javascript'], ['app.css', 'text/css']]) {
    routes.set(`/${name}`, [type, await readFile(new URL(`../www/${name}`, import.meta.url))]);
}
routes.set('/', routes.get('/index.html'));
routes.set('/favicon.ico', ['image/x-icon', '']);
const failures = [], artifacts = process.env.ARTIFACT_DIR;
const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname, route = routes.get(path);
    if (!route) failures.push(`Unexpected HTTP request: ${path}`);
    response.writeHead(route ? 200 : 404, {'Content-Type': route?.[0] || 'text/plain', 'Cache-Control': 'no-store'});
    response.end(route?.[1] || '');
});
const difference = (a, b) => Math.max(...a.map((value, i) => Math.abs(value - b[i])));
const red = colour => colour[0] > colour[1] + 25 && colour[1] < 240;
function rgb(image, [x, y]) {
    assert(x >= 0 && y >= 0 && x < image.width && y < image.height, `Pixel outside screenshot: ${x},${y}`);
    const offset = (Math.floor(y) * image.width + Math.floor(x)) * 4;
    return Array.from(image.data.subarray(offset, offset + 3));
}
async function settle(page) {
    await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished)));
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
            const timer = setTimeout(() => { m.off('idle', done); reject(new Error('Map render timed out')); }, 10000);
            m.once('idle', done);
        });
        m.triggerRepaint();
        await idle;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
}
async function displayed(page, value) {
    await page.waitForFunction(value => document.body.classList.contains('load-complete')
        && window.m?.loaded() && window._columnData?.value[0] === value, value);
    await settle(page);
}
async function frame(page, name, paneOpen = false) {
    await settle(page);
    const geometry = await page.evaluate(points => {
        const canvas = document.getElementById('deckgl-overlay');
        // Inspect the real Deck viewport without adding a production test hook.
        const viewport = m._controls.find(control => control.getCanvas?.()?.id === 'deckgl-overlay')._deck.getViewports()[0];
        const rect = element => {
            const {x, y, width, height} = element.getBoundingClientRect();
            return {x, y, width, height};
        };
        const map = rect(m.getCanvas()), deck = rect(canvas);
        return {map, deck, wrapper: rect(canvas.parentElement), viewport: [viewport.width, viewport.height],
            mapPoints: points.map(point => { const p = m.project(point); return [map.x + p.x, map.y + p.y]; }),
            deckPoints: points.map(point => { const p = viewport.project(point); return [deck.x + p[0], deck.y + p[1]]; }),
            inline: {visibility: canvas.style.visibility, mixBlendMode: canvas.style.mixBlendMode},
            occluders: [...document.querySelectorAll('#search-container, .maplibregl-ctrl, .pane-btn, #attribution, #legend, .utility-controls')]
                .filter(element => getComputedStyle(element).visibility !== 'hidden').map(rect)};
    }, [center, ...boundary]);
    const {map, deck, wrapper, viewport, mapPoints, deckPoints, inline} = geometry, size = page.viewportSize();
    assert(difference([map.width, map.height], [size.width / (paneOpen && size.width > size.height ? 2 : 1),
        size.height / (paneOpen && size.height > size.width ? 2 : 1)]) <= 1, `${name}: pane size`);
    assert([deck, wrapper].every(rect => ['x', 'y', 'width', 'height'].every(key => Math.abs(rect[key] - map[key]) <= 1)), `${name}: canvas alignment`);
    assert(difference(viewport, [map.width, map.height]) <= 1, `${name}: stale Deck viewport`);
    assert(mapPoints.every((point, i) => Math.hypot(point[0] - deckPoints[i][0], point[1] - deckPoints[i][1]) <= 1), `${name}: geographic projection`);
    const screenshot = async suffix => {
        await settle(page);
        const image = PNG.sync.read(await page.screenshot({scale: 'css',
            ...(artifacts ? {path: join(artifacts, `${name}-${suffix}.png`)} : {})}));
        assert.deepEqual([image.width, image.height], [size.width, size.height], 'CSS pixels, including DPR 2');
        return image;
    };
    let baseline, white;
    try {
        await page.evaluate(() => { document.getElementById('deckgl-overlay').style.visibility = 'hidden'; });
        baseline = await screenshot('basemap');
        await page.evaluate(visibility => {
            Object.assign(document.getElementById('deckgl-overlay').style, {visibility, mixBlendMode: 'normal'});
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
    // Independent pixel oracle: no layer colour accessor supplies the expected composite.
    const sample = deckPoints[0];
    assert(safe(sample), `${name}: centre obscured`);
    const expected = rgb(baseline, sample).map((value, i) => value * rgb(white, sample)[i] / 255);
    assert(red(rgb(white, sample)), `${name}: missing red H3`);
    assert(difference(rgb(multiplied, sample), expected) <= 4, `${name}: multiply composite`);
    let edges = 0;
    for (let i = 1; i < mapPoints.length - 1; i++) {
        const midpoint = mapPoints[i].map((value, axis) => (value + mapPoints[i + 1][axis]) / 2);
        const toward = midpoint.map((value, axis) => mapPoints[0][axis] - value), length = Math.hypot(...toward);
        const inner = midpoint.map((value, axis) => value + 3 * toward[axis] / length);
        const outer = midpoint.map((value, axis) => value - 3 * toward[axis] / length);
        if (!safe(inner) || !safe(outer)) continue;
        edges++;
        assert(red(rgb(white, inner)) && difference(rgb(white, outer), [255, 255, 255]) <= 5, `${name}: rasterized H3 edge ${i}`);
    }
    assert(edges >= 3, `${name}: fewer than three unobscured edges`);
    console.log(`${name}: alignment, multiply and ${edges} rasterized edges passed`);
}
async function clickCell(page, index = cell) {
    const point = await page.evaluate(center => {
        const p = m.project(center), rect = m.getCanvas().getBoundingClientRect();
        return [rect.x + p.x, rect.y + p.y];
    }, cellToLatLng(index).reverse());
    await page.mouse.click(...point);
}
async function setting(page, key, value) {
    await page.waitForFunction(([key, value]) => new URL(location.href).searchParams.get(key) === value
        && document.body.classList.contains('load-complete'), [key, value]);
}

let browser;
try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    if (artifacts) await mkdir(artifacts, {recursive: true});
    const origin = `http://127.0.0.1:${server.address().port}`;
    const url = data => `${origin}/?data=${data}#x=${center[0]}&y=${center[1]}&z=8`;
    browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_PATH,
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage']});
    for (const [device, width, height, deviceScaleFactor] of [['desktop', 1200, 850, 1], ['mobile', 375, 812, 2]]) {
        const context = await browser.newContext({viewport: {width, height}, deviceScaleFactor, reducedMotion: 'reduce', serviceWorkers: 'block'});
        const page = await context.newPage();
        page.setDefaultTimeout(20000);
        page.on('pageerror', error => failures.push(`${device}: ${error.stack}`));
        page.on('console', message => {
            if (message.type() === 'error' && !message.text().includes('HTTP 503: selection-test-failure')
                && message.text() !== 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)'
                && message.text() !== 'Error: <g> attribute transform: Expected transform function, "0".') failures.push(message.text());
        });
        await context.route('**/*', route => {
            if (new URL(route.request().url()).origin === origin) return route.continue();
            failures.push(`Unexpected external request: ${route.request().url()}`);
            return route.abort();
        });
        await context.routeWebSocket('**/*', socket => socket.onMessage(message => {
            if (String(message).startsWith('watch:')) socket.send('watching:rendering.csv');
        }));
        try {
            await page.goto(url('rendering.csv'));
            await displayed(page, 0.65);
            await page.mouse.move(0, 0);
            await frame(page, `${device}-flat`);
            await page.evaluate(center => m.jumpTo({bearing: 30, pitch: 35, zoom: 7.7,
                center: [center[0] + 0.025, center[1] + 0.015]}), center);
            await frame(page, `${device}-camera`);
            await page.evaluate(() => {
                document.body.classList.remove('pane-open', 'pane-full');
                document.body.classList.add('cartogram-ready');
            });
            await page.locator('#leftExpand').evaluate(button => button.click());
            await frame(page, `${device}-pane`, true);
            await page.setViewportSize({width: height, height: width});
            await frame(page, `${device}-orientation`, true);
            await page.locator('#rightExpand').evaluate(button => button.click());
            assert(await page.locator('#map').isHidden(), 'Full cartogram pane hides map');
            await page.locator('#rightExpand').evaluate(button => button.click());
            await page.locator('#leftExpand').evaluate(button => button.click());
            await frame(page, `${device}-restored`);

            await page.setViewportSize({width, height});
            await page.goto(url('settings.arrow&raw=true&linear=true'));
            await displayed(page, 10);
            await page.locator('#settingsBtn').click();
            const selector = page.getByRole('combobox', {name: 'Colour scale', exact: true});
            assert.equal(await selector.inputValue(), 'raw', 'Legacy URL precedence');
            assert.equal(await page.locator('#setting-raw, #setting-linear, #setting-rankit').count(), 0);
            const fixed = await page.evaluate(() => {
                const fields = document.querySelector('#settingsFields');
                fields.querySelectorAll('details').forEach(help => { help.open = true; });
                const rects = () => ['.settings-panel-header', '.settings-actions'].map(s => document.querySelector(s).getBoundingClientRect().toJSON());
                fields.scrollTop = 0;
                const before = rects();
                fields.scrollTop = fields.scrollHeight;
                return {before, after: rects(), scroll: fields.scrollTop};
            });
            assert(fixed.scroll > 0, 'Settings fields scroll');
            assert.deepEqual(fixed.after, fixed.before, 'Header and actions stay fixed while fields scroll');
            const title = 'A long title with ordinary words and literal <b>markup</b> '.repeat(5).trim();
            await page.locator('#setting-t').fill(title);
            await setting(page, 't', title);
            await selector.selectOption('linear');
            await setting(page, 'colourScale', 'linear');
            assert(!new URL(page.url()).searchParams.has('raw') && !new URL(page.url()).searchParams.has('linear'));
            await page.locator('#settingsClose').click();
            await settle(page);
            const titleLayout = await page.locator('#observable_legend > :last-child').evaluate(entry => {
                const title = entry.querySelector('div.title'), range = document.createRange();
                range.selectNodeContents(title);
                return {lines: new Set([...range.getClientRects()].map(r => r.top)).size, markup: title.childElementCount,
                    bounds: [...range.getClientRects()].map(r => [r.left, r.right]),
                    bottom: title.getBoundingClientRect().bottom, bar: entry.querySelector('svg').getBoundingClientRect().top};
            });
            assert(titleLayout.lines > 1 && titleLayout.markup === 0 && titleLayout.bar >= titleLayout.bottom);
            assert(titleLayout.bounds.every(([left, right]) => left >= -1 && right <= width + 1), 'Wrapped title stays on screen');
            await page.reload();
            await displayed(page, 10);
            await page.locator('#settingsBtn').click();
            assert.equal(await selector.inputValue(), 'linear', 'Shared URL restores single selector');
            const ticks = await page.locator('#observable_legend .tick').allTextContents();
            const beforeFlip = await page.locator('#observable_legend image').getAttribute('href');
            await page.locator('#setting-flip').check();
            await setting(page, 'flip', '1');
            await settle(page);
            assert.deepEqual(await page.locator('#observable_legend .tick').allTextContents(), ticks, 'Flip preserves numeric ticks');
            assert.notEqual(await page.locator('#observable_legend image').getAttribute('href'), beforeFlip, 'Flip changes gradient');
            await page.locator('#settingsResetAll').click();
            await setting(page, 'colourScale', null);
            assert.equal(await selector.inputValue(), 'rankit', 'Reset restores metadata');
            if (device === 'mobile') continue; // Protocol and validation combinations belong to unit tests, not a device matrix.

            const trim = page.locator('#setting-trimFactor'), scale = page.locator('textarea#setting-scale');
            await trim.fill('0.1');
            await setting(page, 'trimFactor', '0.1');
            await trim.fill('0.8');
            assert.equal(await trim.getAttribute('aria-invalid'), 'true');
            await trim.press('ControlOrMeta+A');
            await trim.press('-');
            assert(await trim.evaluate(input => input.validity.badInput), 'Keyboard input exercises native badInput');
            await scale.fill('{broken');
            assert.equal(await scale.getAttribute('aria-invalid'), 'true');
            // A later debounced title commit is the barrier for invalid edits, rather than an arbitrary sleep.
            await page.locator('#setting-t').fill('Validation barrier');
            await setting(page, 't', 'Validation barrier');
            assert.equal(new URL(page.url()).searchParams.get('trimFactor'), '0.1');
            assert.equal(new URL(page.url()).searchParams.get('scale'), null, 'Invalid JSON does not apply');
            await trim.fill('0.2');
            await setting(page, 'trimFactor', '0.2');
            await scale.fill('{"0":"Low","100":"High"}');
            await setting(page, 'scale', 'json:{"0":"Low","100":"High"}');
            await scale.fill('');
            await setting(page, 'scale', 'json:null');

            // Real Arrow aggregation and canvas hit testing: a positive-weight missing contributor suppresses its target.
            await page.goto(url('coverage.arrow'));
            await displayed(page, 0.6);
            const coverageTooltip = async (row, expected) => {
                await page.waitForFunction(() => document.body.classList.contains('cartogram-ready') && document.body.classList.contains('load-complete'));
                await settle(page);
                await page.locator('#cartogram canvas').evaluate((canvas, row) => {
                    const rect = canvas.getBoundingClientRect(), scale = Math.min(rect.width / 45, rect.height / 35);
                    const [x, y] = canvas.__zoom.apply([(rect.width - 45 * scale) / 2 + (12.5 + row * 10) * scale,
                        (rect.height - 35 * scale) / 2 + (row === 1 ? 22.5 : 12.5) * scale]);
                    canvas.dispatchEvent(new MouseEvent('mouseleave'));
                    canvas.dispatchEvent(new MouseEvent('mousemove', {clientX: rect.x + x, clientY: rect.y + y, bubbles: true}));
                }, row);
                await page.locator('.cartogram-tooltip').waitFor({state: 'visible'});
                const rows = await page.locator('.cartogram-tooltip div').allTextContents();
                assert(rows.includes(`x: ${row * 2}`));
                assert.equal(rows.find(text => text.startsWith('value_mean:')), expected === null ? undefined : `value_mean: ${expected}`);
                if (expected === null) assert(!rows.some(text => text.startsWith('carto_quantile:')));
            };
            await coverageTooltip(0, 0.6);
            await page.locator('#settingsBtn').click();
            await page.getByRole('checkbox', {name: 'Require complete coverage', exact: true}).check();
            await setting(page, 'requireCompleteCoverage', '1');
            await coverageTooltip(0, null);
            await coverageTooltip(1, 0);

            // One HTTP lifecycle: labels and selection track displayed results, never pending or failed queries.
            const action = {url: '/selection-result?index={index}&time={controls.time}', focus: false, highlight: true};
            const metadata = {cartogram: 'none', trimFactor: 0, t: 'From {TOWN_NAME}: {controls.time} min',
                controls: {time: {label: 'Travel time', type: 'number', default: 2, encode: 'value => value * 60'}}, onclick: action};
            json('/data/query.json', metadata);
            let pending;
            await page.route('**/selection-result?*', route => { pending = route; });
            await page.goto(url('query.csv'));
            await displayed(page, 0.65);
            const marker = () => page.evaluate(() => m._controls.find(c => c.getCanvas?.()?.id === 'deckgl-overlay')
                ._deck.props.layers.find(layer => layer.id === 'hex-highlight')?.props.data || []);
            const checkTitle = async text => {
                assert.equal(await page.title(), text);
                assert.equal(await page.locator('#observable_legend > :last-child .title').textContent(), text);
            };
            const request = page.waitForRequest('**/selection-result?*');
            await clickCell(page);
            assert.equal(new URL((await request).url()).searchParams.get('time'), '120');
            await checkTitle(metadata.t);
            assert.deepEqual(await marker(), []);
            await pending.fulfill({contentType: 'application/octet-stream', body: values(10)});
            await displayed(page, 10);
            const firstTitle = `From ${findClosestCity(...cellToLatLng(cell)).name}: 2 min`;
            await checkTitle(firstTitle);
            assert.deepEqual(await marker(), [cell]);
            const failed = page.waitForRequest('**/selection-result?*');
            await clickCell(page, cells[1]);
            await failed;
            await checkTitle(firstTitle);
            await pending.fulfill({status: 503, body: 'selection-test-failure'});
            await page.waitForFunction(() => document.body.classList.contains('load-error'));
            await checkTitle(firstTitle);
            assert.deepEqual(await marker(), [cell]);
            const retry = page.waitForRequest('**/selection-result?*');
            await page.getByRole('button', {name: 'Retry', exact: true}).click();
            assert.equal((await retry).url(), (await failed).url());
            await pending.fulfill({contentType: 'application/octet-stream', body: values(12)});
            await displayed(page, 12);
            await checkTitle(`From ${findClosestCity(...cellToLatLng(cells[1])).name}: 2 min`);
            assert.deepEqual(await marker(), [cells[1]]);

            // Persistent socket: rapid latest/trailing replies, reconnect and settings progress under continuous traffic.
            const sockets = [], queries = [];
            let streaming = false;
            const reply = (query, value) => {
                const id = Buffer.alloc(4);
                id.writeUInt32BE(query.id);
                query.socket.send(Buffer.concat([id, values(value)]));
            };
            await page.routeWebSocket('**/query-stream', socket => {
                sockets.push(socket);
                socket.onMessage(message => {
                    const query = {...JSON.parse(String(message)), socket};
                    assert.equal(query.type, 'query');
                    queries.push(query);
                    if (streaming) reply(query, 35);
                });
            });
            const received = async count => {
                const deadline = Date.now() + 20000;
                while (queries.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
                assert.equal(queries.length, count, 'One query per interaction, no replay backlog');
                return queries.at(-1);
            };
            const socketAction = {...action, url: action.url + '&lng={lng}', socket: origin.replace('http:', 'ws:') + '/query-stream', wait: 0};
            json('/data/query.json', {...metadata, colourScale: 'linear', onclick: socketAction, onmove: socketAction});
            await page.goto(url('query.csv'));
            await displayed(page, 0.65);
            await clickCell(page);
            reply(await received(1), 10);
            await displayed(page, 10);
            await clickCell(page, cells[1]);
            await received(2);
            await clickCell(page, cells[2]);
            reply(await received(3), 20);
            reply(queries[1], 99);
            await displayed(page, 20);
            const move = (continuous = false) => {
                const tick = () => {
                    m.jumpTo({center: [m.getCenter().lng + 0.001, m.getCenter().lat]});
                    m.fire('movestart', {keyboardMoving: true});
                    m.fire('move');
                    m.fire('moveend');
                };
                if (continuous) window.traffic = setInterval(tick, 40);
                else tick();
            };
            for (let i = 0; i < 3; i++) await page.evaluate(move);
            await received(6);
            reply(queries[4], 30);
            await displayed(page, 30); // Trailing response progresses even with a newer request in flight.
            reply(queries[3], 98);
            await settle(page);
            assert.equal(await page.evaluate(() => window._columnData.value[0]), 30, 'Older reply cannot replace displayed trailing result');
            reply(queries[5], 40);
            await displayed(page, 40);
            assert.equal(sockets.length, 1);
            await page.evaluate(move);
            const outstanding = await received(7);
            await sockets[0].close({code: 1011, reason: 'controlled disconnect'});
            const reconnected = await received(8);
            assert.equal(sockets.length, 2);
            assert.equal(reconnected.url, outstanding.url);
            reply(reconnected, 50);
            await displayed(page, 50);
            await page.locator('#settingsBtn').click();
            streaming = true;
            await page.evaluate(move, true);
            try {
                await page.getByRole('spinbutton', {name: 'Travel time', exact: true}).fill('3');
                await page.waitForFunction(() => document.title.endsWith(': 3 min') && window._columnData?.value[0] === 35);
                assert.equal(new URL(queries.at(-1).url, origin).searchParams.get('time'), '180');
                await page.waitForFunction(() => Math.abs(window._columnData?.quantile?.[0] - 1 / 6) < 1e-6);
                await selector.selectOption('rankit');
                await page.waitForFunction(() => new URL(location.href).searchParams.get('colourScale') === 'rankit'
                    && Math.abs(window._columnData?.quantile?.[0] - 0.5) < 1e-6);
                assert(queries.length > 9, 'Settings finish while multiple results arrive');
            } finally {
                await page.evaluate(() => clearInterval(window.traffic));
                streaming = false;
            }
            console.log('Desktop settings, Arrow coverage, HTTP selection and persistent socket passed');
        } catch (error) {
            failures.push(`${device}: ${error.stack}`);
        } finally {
            await context.close();
        }
    }
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
}
assert.deepEqual(failures, [], 'Browser release regressions');
