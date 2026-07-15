import * as d3 from 'd3'

const TRANSPARENT_COLOUR = 'rgba(0,0,0,0)'
const DEFAULT_COLOUR_SCALE = d3.scaleSequential(d3.interpolateSpectral).domain([0,1])

function defaultGetColour(z) {
    if (z == null) return TRANSPARENT_COLOUR
    const number = Number(z)
    return Number.isFinite(number) ? (DEFAULT_COLOUR_SCALE(number) ?? TRANSPARENT_COLOUR) : TRANSPARENT_COLOUR
}

export function render_cartogram(container, data, options = {}) {
    const {
        square_size = 10,
        coord_step = 2,
        padding = 20,
        draw_outline = false,
        outline_color = "black",
        outline_width = 0.5,
        draw_country_borders = true,
        country_border_color = "black",
        country_border_width = 1.5,
        include_outer_borders = false,
        font_size = 8,
        font_face = "Iosevka, monospace",
        text_color = "black",
        label_min_screen_px = 8,
        max_canvas_labels = 5000,
        data_col = 'code',
        perf = false,
        svgPerf = false,
        debug = false,
        get_color = defaultGetColour,
        color_transition_duration = 500,
        onclick_callback = console.log,
        onmove_callback = () => {},
        onviewchange_callback = () => {},
    } = options

    const HTML_ESCAPES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}
    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, c => HTML_ESCAPES[c])
    }

    const perfNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())
    function perfTimer(label, details) {
        if (!perf) return () => {}
        const start = perfNow()
        return (extra) => {
            const elapsed = perfNow() - start
            const merged = {...(details || {}), ...(extra || {})}
            if (Object.keys(merged).length) {
                console.info(`[perf] cartogram.canvas.${label}: ${elapsed.toFixed(1)}ms`, merged)
            } else {
                console.info(`[perf] cartogram.canvas.${label}: ${elapsed.toFixed(1)}ms`)
            }
        }
    }
    function debugLog(label, details) {
        if (debug) console.info(`[sync] cartogram.${label}`, details || {})
    }
    function svgPerfLog(label, details) {
        if (svgPerf) console.info(`[svgperf] cartogram.${label}`, details || {})
    }

    let currentData = data
    let currentDataCol = data_col
    const xCol = currentData.x
    const yCol = currentData.y
    const codeCol = currentData.code
    const labelCol = currentData.label

    if (!xCol || !yCol || !codeCol) {
        console.error("Missing required columns: x, y, or code.")
        return
    }

    const numRows = xCol.length
    const doneRender = perfTimer('render.total', {rows: numRows})
    const doneLayout = perfTimer('layout', {rows: numRows})
    const minX = d3.min(xCol)
    const maxX = d3.max(xCol)
    const minY = d3.min(yCol)
    const maxY = d3.max(yCol)
    const width = Math.ceil((maxX - minX + 1) * square_size + 2 * padding) / 2
    const height = Math.ceil((maxY - minY + 1) * square_size + 2 * padding) / 2
    const center_x = (minX + maxX) / 2
    const center_y = (minY + maxY) / 2
    const getX = (x) => width / 2 + (x - center_x) * square_size / 2
    const getY = (y) => height / 2 + (y - center_y) * square_size / 2
    doneLayout({width, height, renderer: 'canvas'})

    const root = d3.select(container)
    root.selectAll("svg").remove()
    root.selectAll("canvas").remove()
    root.selectAll(".cartogram-tooltip").remove()
    root.style("position", "relative")

    const doneCreate = perfTimer('create')
    const canvasSelection = root.append("canvas")
        .style("position", "absolute")
        .style("inset", "0")
        .style("width", "100%")
        .style("height", "100%")
        .style("display", "block")
    const canvas = canvasSelection.node()
    const ctx = canvas.getContext('2d')
    doneCreate()

    const cellKey = (x, y) => `${x},${y}`
    const rowByCell = new Map()
    const codeByCell = new Map()
    const cellX = new Float32Array(numRows)
    const cellY = new Float32Array(numRows)
    let colors = new Array(numRows)
    let colorGroups = []
    let cellRaster = null
    let cellRasterDirty = true
    let colorTransition = null
    let colorTransitionRaf = null
    let borderLines = []
    let labelCount = 0
    let labeledIndices = []
    let labelAngles = []
    let highlightedIndices = []
    let latestTransform = d3.zoomIdentity
    let fitToBoundsActive = false
    let fitToBoundsToken = 0
    let cartogramGestureActive = false
    let cartogramGestureMoved = false
    let pendingTransform = null
    let transformRaf = null
    let canvasCssWidth = 0
    let canvasCssHeight = 0
    let canvasDpr = 1
    let svgPerfGestureId = 0
    let svgPerfGesture = null
    let svgPerfFrameRaf = null
    let svgPerfDrawFrameId = 0
    let svgPerfLastDrawFrameLog = 0

    const donePrecompute = perfTimer('cells.precompute', {rows: numRows})
    for (let i = 0; i < numRows; i++) {
        const x = xCol[i]
        const y = yCol[i]
        const key = cellKey(x, y)
        rowByCell.set(key, i)
        codeByCell.set(key, codeCol[i])
        cellX[i] = getX(x)
        cellY[i] = getY(y)
    }
    donePrecompute({cells: rowByCell.size})

    function updateColors(col) {
        const doneColors = perfTimer('colors.update', {rows: numRows})
        colors = new Array(numRows)
        const groups = new Map()
        for (let i = 0; i < numRows; i++) {
            const color = get_color(col[i]) ?? TRANSPARENT_COLOUR
            colors[i] = color
            if (color === TRANSPARENT_COLOUR) continue
            let indices = groups.get(color)
            if (!indices) {
                indices = []
                groups.set(color, indices)
            }
            indices.push(i)
        }
        colorGroups = Array.from(groups, ([color, indices]) => ({color, indices}))
        cellRasterDirty = true
        doneColors({colorGroups: colorGroups.length})
    }
    updateColors(currentData[currentDataCol])

    function createCanvas(width, height) {
        if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        return canvas
    }

    function ensureCellRaster() {
        if (!cellRasterDirty && cellRaster) return {raster: cellRaster, buildMs: 0, rebuilt: false}
        const buildStart = svgPerf ? perfNow() : 0
        const footprint = Math.max(1, Math.round(coord_step))
        const coordinateUnit = square_size / 2
        const rasterWidth = Math.max(1, Math.ceil(Number(maxX) - Number(minX) + footprint))
        const rasterHeight = Math.max(1, Math.ceil(Number(maxY) - Number(minY) + footprint))
        const rasterCanvas = createCanvas(rasterWidth, rasterHeight)
        const rasterCtx = rasterCanvas.getContext('2d')
        rasterCtx.imageSmoothingEnabled = false
        rasterCtx.clearRect(0, 0, rasterWidth, rasterHeight)
        if (draw_outline) {
            rasterCtx.strokeStyle = outline_color
            rasterCtx.lineWidth = Math.max(1, outline_width)
        }
        for (const group of colorGroups) {
            rasterCtx.fillStyle = group.color
            for (const i of group.indices) {
                const left = Math.max(0, Math.round(Number(xCol[i]) - Number(minX)))
                const top = Math.max(0, Math.round(Number(yCol[i]) - Number(minY)))
                rasterCtx.fillRect(left, top, footprint, footprint)
                if (draw_outline) rasterCtx.strokeRect(left, top, footprint, footprint)
            }
        }
        const half = square_size / 2
        cellRaster = {
            canvas: rasterCanvas,
            scale: coordinateUnit,
            width: rasterWidth,
            height: rasterHeight,
            modelX: getX(minX) - half,
            modelY: getY(minY) - half,
            modelWidth: rasterWidth * coordinateUnit,
            modelHeight: rasterHeight * coordinateUnit,
            footprint,
        }
        cellRasterDirty = false
        return {raster: cellRaster, buildMs: svgPerf ? perfNow() - buildStart : 0, rebuilt: true}
    }

    const colorTransitionDuration = Math.max(0, Number(color_transition_duration) || 0)

    function colorTransitionProgress(transition) {
        return Math.min(1, Math.max(0, (perfNow() - transition.startedAt) / transition.duration))
    }

    function currentCellRaster() {
        const target = ensureCellRaster().raster
        if (!colorTransition) return target

        const progress = d3.easeCubicInOut(colorTransitionProgress(colorTransition))
        if (progress >= 1) {
            colorTransition = null
            return target
        }

        const canvas = createCanvas(target.width, target.height)
        const blendCtx = canvas.getContext('2d')
        blendCtx.imageSmoothingEnabled = false
        blendCtx.globalCompositeOperation = 'lighter'
        blendCtx.globalAlpha = 1 - progress
        blendCtx.drawImage(colorTransition.from.canvas, 0, 0, target.width, target.height)
        blendCtx.globalAlpha = progress
        blendCtx.drawImage(target.canvas, 0, 0, target.width, target.height)
        return {...target, canvas}
    }

    function scheduleColorTransitionFrame() {
        if (!colorTransition || colorTransitionRaf !== null || typeof requestAnimationFrame !== 'function') return
        colorTransitionRaf = requestAnimationFrame(drawColorTransitionFrame)
    }

    function drawColorTransitionFrame() {
        colorTransitionRaf = null
        if (!colorTransition) return
        if (colorTransitionProgress(colorTransition) >= 1) colorTransition = null
        scheduleTransform(latestTransform)
        scheduleColorTransitionFrame()
    }

    function updateColorsWithTransition(col) {
        const animate = colorTransitionDuration > 0 && typeof requestAnimationFrame === 'function'
        const from = animate ? currentCellRaster() : null
        updateColors(col)
        colorTransition = from ? {from, duration: colorTransitionDuration, startedAt: perfNow()} : null
        if (!colorTransition && colorTransitionRaf !== null) {
            cancelAnimationFrame(colorTransitionRaf)
            colorTransitionRaf = null
        }
        drawCanvas(latestTransform)
        scheduleColorTransitionFrame()
    }

    if (draw_country_borders) {
        const doneBorders = perfTimer('borders.precompute', {rows: numRows})
        borderLines = []
        for (let i = 0; i < numRows; i++) {
            const x = xCol[i]
            const y = yCol[i]
            const code = codeCol[i]
            const cx = cellX[i]
            const cy = cellY[i]
            const rCode = codeByCell.get(cellKey(x + coord_step, y))
            if (rCode !== code && (include_outer_borders || rCode !== undefined)) {
                borderLines.push({x1: cx + square_size / 2, y1: cy - square_size / 2, x2: cx + square_size / 2, y2: cy + square_size / 2})
            }
            const bCode = codeByCell.get(cellKey(x, y + coord_step))
            if (bCode !== code && (include_outer_borders || bCode !== undefined)) {
                borderLines.push({x1: cx - square_size / 2, y1: cy + square_size / 2, x2: cx + square_size / 2, y2: cy + square_size / 2})
            }
            if (include_outer_borders) {
                if (codeByCell.get(cellKey(x - coord_step, y)) === undefined) {
                    borderLines.push({x1: cx - square_size / 2, y1: cy - square_size / 2, x2: cx - square_size / 2, y2: cy + square_size / 2})
                }
                if (codeByCell.get(cellKey(x, y - coord_step)) === undefined) {
                    borderLines.push({x1: cx - square_size / 2, y1: cy - square_size / 2, x2: cx + square_size / 2, y2: cy - square_size / 2})
                }
            }
        }
        doneBorders({borders: borderLines.length})
    }

    if (labelCol) {
        const doneLabels = perfTimer('labels.precompute', {rows: numRows})
        labeledIndices = []
        labelAngles = new Float32Array(numRows)
        for (let i = 0; i < numRows; i++) {
            const label = labelCol[i]
            if (label === null || label === undefined || label === "") continue
            labeledIndices.push(i)
            labelAngles[i] = ((Math.random() * 90) - 45) * Math.PI / 180
        }
        labelCount = labeledIndices.length
        doneLabels({labels: labelCount, renderer: 'canvas'})
    }

    function transformDetails(transform) {
        return transform ? {x: transform.x, y: transform.y, k: transform.k} : null
    }

    function viewTransform() {
        const rect = canvas.getBoundingClientRect()
        if (!rect.width || !rect.height) return {scale: 1, offsetX: 0, offsetY: 0, cssWidth: 0, cssHeight: 0}
        const scale = Math.max(rect.width / width, rect.height / height)
        return {
            scale,
            offsetX: (rect.width - width * scale) / 2,
            offsetY: (rect.height - height * scale) / 2,
            cssWidth: rect.width,
            cssHeight: rect.height,
        }
    }

    function visibleViewport() {
        const vt = viewTransform()
        if (!vt.cssWidth || !vt.cssHeight) return {xMin: 0, yMin: 0, xMax: width, yMax: height}
        return {
            xMin: -vt.offsetX / vt.scale,
            yMin: -vt.offsetY / vt.scale,
            xMax: (vt.cssWidth - vt.offsetX) / vt.scale,
            yMax: (vt.cssHeight - vt.offsetY) / vt.scale,
        }
    }

    function cssToViewTransform(transform) {
        const vt = viewTransform()
        if (!vt.scale) return d3.zoomIdentity
        return d3.zoomIdentity
            .translate(
                (transform.x + vt.offsetX * (transform.k - 1)) / vt.scale,
                (transform.y + vt.offsetY * (transform.k - 1)) / vt.scale
            )
            .scale(transform.k)
    }

    function viewToCssTransform(transform) {
        const vt = viewTransform()
        return d3.zoomIdentity
            .translate(
                transform.x * vt.scale - vt.offsetX * (transform.k - 1),
                transform.y * vt.scale - vt.offsetY * (transform.k - 1)
            )
            .scale(transform.k)
    }

    function resizeCanvas() {
        const rect = canvas.getBoundingClientRect()
        const dpr = window.devicePixelRatio || 1
        const nextWidth = Math.max(1, Math.round(rect.width * dpr))
        const nextHeight = Math.max(1, Math.round(rect.height * dpr))
        const changed = canvas.width !== nextWidth || canvas.height !== nextHeight || canvasDpr !== dpr
        if (changed) {
            canvas.width = nextWidth
            canvas.height = nextHeight
            canvasDpr = dpr
        }
        canvasCssWidth = rect.width
        canvasCssHeight = rect.height
        return changed
    }

    function canvasToViewBox(event) {
        const rect = canvas.getBoundingClientRect()
        const vt = viewTransform()
        return {
            x: (event.clientX - rect.left - vt.offsetX) / vt.scale,
            y: (event.clientY - rect.top - vt.offsetY) / vt.scale,
        }
    }

    function visibleIndices(transform) {
        const doneVisible = perfTimer('visible_indices', {rows: numRows})
        const viewport = visibleViewport()
        const visible = []
        for (let i = 0; i < numRows; i++) {
            const halfExtent = square_size * transform.k / 2
            const sx = cellX[i] * transform.k + transform.x
            const sy = cellY[i] * transform.k + transform.y
            if (sx + halfExtent >= viewport.xMin && sx - halfExtent <= viewport.xMax &&
                sy + halfExtent >= viewport.yMin && sy - halfExtent <= viewport.yMax) {
                visible.push(i)
            }
        }
        doneVisible({visible: visible.length})
        debugLog('visible_indices', {
            visible: visible.length,
            rows: numRows,
            viewport,
            transform: transformDetails(transform),
            firstRows: visible.slice(0, 10),
        })
        return visible
    }

    function svgPerfFrame() {
        if (!svgPerfGesture) {
            svgPerfFrameRaf = null
            return
        }
        const now = perfNow()
        const gap = now - svgPerfGesture.lastFrameTime
        svgPerfGesture.frameCount++
        svgPerfGesture.frameTotalMs += gap
        if (gap > svgPerfGesture.maxFrameGapMs) svgPerfGesture.maxFrameGapMs = gap
        if (gap > 16.7) svgPerfGesture.frameGapsOver16ms++
        if (gap > 32) svgPerfGesture.frameGapsOver32ms++
        if (gap > 50) svgPerfGesture.frameGapsOver50ms++
        svgPerfGesture.lastFrameTime = now
        svgPerfFrameRaf = requestAnimationFrame(svgPerfFrame)
    }

    function startSvgPerfGesture(event, transform) {
        if (!svgPerf) return
        if (svgPerfGesture) endSvgPerfGesture({interrupted: true})
        const now = perfNow()
        svgPerfGesture = {
            id: ++svgPerfGestureId,
            startTime: now,
            lastFrameTime: now,
            sourceEventType: event && event.sourceEvent ? event.sourceEvent.type : null,
            sourceEventTarget: event && event.sourceEvent && event.sourceEvent.target ? event.sourceEvent.target.tagName : null,
            userGesture: !!(event && event.sourceEvent),
            fitToBoundsActiveAtStart: fitToBoundsActive,
            initialTransform: transformDetails(transform),
            zoomEvents: 0,
            transformWrites: 0,
            handlerTotalMs: 0,
            maxHandlerMs: 0,
            drawTotalMs: 0,
            maxDrawMs: 0,
            drawnCellTotal: 0,
            maxDrawnCells: 0,
            drawnBorderTotal: 0,
            drawnLabelTotal: 0,
            maxDrawnLabels: 0,
            frameCount: 0,
            frameTotalMs: 0,
            maxFrameGapMs: 0,
            frameGapsOver16ms: 0,
            frameGapsOver32ms: 0,
            frameGapsOver50ms: 0,
            tooltipEvents: {mouseenter: 0, mousemove: 0, mouseleave: 0, suppressed: 0},
            longTasks: 0,
            longTaskTotalMs: 0,
            maxLongTaskMs: 0,
        }
        if (typeof requestAnimationFrame === 'function') svgPerfFrameRaf = requestAnimationFrame(svgPerfFrame)
    }

    function recordSvgPerfZoom(handlerMs) {
        if (!svgPerfGesture) return
        svgPerfGesture.zoomEvents++
        svgPerfGesture.handlerTotalMs += handlerMs
        if (handlerMs > svgPerfGesture.maxHandlerMs) svgPerfGesture.maxHandlerMs = handlerMs
    }

    function recordSvgPerfDraw(drawMs, drawnCells, drawnBorders, drawnLabels = 0) {
        if (!svgPerfGesture) return
        svgPerfGesture.transformWrites++
        svgPerfGesture.drawTotalMs += drawMs
        if (drawMs > svgPerfGesture.maxDrawMs) svgPerfGesture.maxDrawMs = drawMs
        svgPerfGesture.drawnCellTotal += drawnCells
        if (drawnCells > svgPerfGesture.maxDrawnCells) svgPerfGesture.maxDrawnCells = drawnCells
        svgPerfGesture.drawnBorderTotal += drawnBorders
        svgPerfGesture.drawnLabelTotal += drawnLabels
        if (drawnLabels > svgPerfGesture.maxDrawnLabels) svgPerfGesture.maxDrawnLabels = drawnLabels
    }

    function recordSvgPerfTooltip(kind) {
        if (svgPerfGesture && svgPerfGesture.tooltipEvents[kind] !== undefined) svgPerfGesture.tooltipEvents[kind]++
    }

    function logSvgPerfDrawFrame(details) {
        if (!svgPerf) return
        const now = perfNow()
        const slow = details.drawMs > 16 || details.cellsMs > 8 || details.bordersMs > 8 || details.labelsMs > 8
        const labelCapped = details.drawnLabels >= max_canvas_labels
        if (!slow && !labelCapped && now - svgPerfLastDrawFrameLog < 250) return
        svgPerfLastDrawFrameLog = now
        svgPerfLog('draw.frame', {
            frame: ++svgPerfDrawFrameId,
            phase: fitToBoundsActive ? 'fit' : (cartogramGestureActive ? 'gesture' : 'idle'),
            slow,
            labelCapped,
            ...details,
        })
    }

    function endSvgPerfGesture(extra = {}) {
        if (!svgPerfGesture) return
        const now = perfNow()
        const gesture = svgPerfGesture
        svgPerfGesture = null
        if (svgPerfFrameRaf !== null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(svgPerfFrameRaf)
            svgPerfFrameRaf = null
        }
        const elapsedMs = now - gesture.startTime
        const avgFrameGapMs = gesture.frameCount ? gesture.frameTotalMs / gesture.frameCount : 0
        svgPerfLog('gesture', {
            renderer: 'canvas',
            id: gesture.id,
            elapsedMs,
            sourceEventType: gesture.sourceEventType,
            endSourceEventType: extra.endSourceEventType || null,
            sourceEventTarget: gesture.sourceEventTarget,
            userGesture: gesture.userGesture,
            fitToBoundsActiveAtStart: gesture.fitToBoundsActiveAtStart,
            moved: extra.moved,
            interrupted: !!extra.interrupted,
            zoomEvents: gesture.zoomEvents,
            transformWrites: gesture.transformWrites,
            handlerTotalMs: gesture.handlerTotalMs,
            avgHandlerMs: gesture.zoomEvents ? gesture.handlerTotalMs / gesture.zoomEvents : 0,
            maxHandlerMs: gesture.maxHandlerMs,
            drawTotalMs: gesture.drawTotalMs,
            avgDrawMs: gesture.transformWrites ? gesture.drawTotalMs / gesture.transformWrites : 0,
            maxDrawMs: gesture.maxDrawMs,
            avgDrawnCells: gesture.transformWrites ? gesture.drawnCellTotal / gesture.transformWrites : 0,
            maxDrawnCells: gesture.maxDrawnCells,
            avgDrawnBorders: gesture.transformWrites ? gesture.drawnBorderTotal / gesture.transformWrites : 0,
            avgDrawnLabels: gesture.transformWrites ? gesture.drawnLabelTotal / gesture.transformWrites : 0,
            maxDrawnLabels: gesture.maxDrawnLabels,
            frameCount: gesture.frameCount,
            avgFrameGapMs,
            approxFps: avgFrameGapMs ? 1000 / avgFrameGapMs : null,
            maxFrameGapMs: gesture.maxFrameGapMs,
            frameGapsOver16ms: gesture.frameGapsOver16ms,
            frameGapsOver32ms: gesture.frameGapsOver32ms,
            frameGapsOver50ms: gesture.frameGapsOver50ms,
            tooltipEvents: gesture.tooltipEvents,
            longTasks: gesture.longTasks,
            longTaskTotalMs: gesture.longTaskTotalMs,
            maxLongTaskMs: gesture.maxLongTaskMs,
            initialTransform: gesture.initialTransform,
            finalTransform: transformDetails(latestTransform),
            nodes: {
                renderer: 'canvas',
                canvas: 1,
                labels: 0,
                canvasLabels: labelCount,
                total: 1,
                cellShapes: numRows,
                borderSegments: borderLines.length,
                cellEventListeners: 0,
                delegatedEventListeners: 4,
                cssWidth: canvasCssWidth,
                cssHeight: canvasCssHeight,
                dpr: canvasDpr,
            },
        })
    }

    if (svgPerf && typeof PerformanceObserver !== 'undefined') {
        try {
            const observer = new PerformanceObserver((list) => {
                if (!svgPerfGesture) return
                for (const entry of list.getEntries()) {
                    svgPerfGesture.longTasks++
                    svgPerfGesture.longTaskTotalMs += entry.duration
                    if (entry.duration > svgPerfGesture.maxLongTaskMs) svgPerfGesture.maxLongTaskMs = entry.duration
                }
            })
            observer.observe({entryTypes: ['longtask']})
        } catch (e) {
            svgPerfLog('longtask_observer_unavailable', {message: e && e.message})
        }
    }

    function drawCanvas(transform = latestTransform) {
        if (!ctx) return
        const drawStart = svgPerf ? perfNow() : 0
        const resizeStart = drawStart
        const resized = resizeCanvas()
        const resizeMs = svgPerf ? perfNow() - resizeStart : 0
        const vt = viewTransform()
        const clearStart = svgPerf ? perfNow() : 0
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        const clearMs = svgPerf ? perfNow() - clearStart : 0
        if (!canvasCssWidth || !canvasCssHeight) {
            if (svgPerf) {
                logSvgPerfDrawFrame({
                    skipped: 'no-canvas-size',
                    drawMs: perfNow() - drawStart,
                    resizeMs,
                    clearMs,
                    cellsMs: 0,
                    bordersMs: 0,
                    labelsMs: 0,
                    highlightMs: 0,
                    drawnCells: 0,
                    drawnBorders: 0,
                    drawnLabels: 0,
                    screenFontPx: 0,
                    resized,
                    cssWidth: canvasCssWidth,
                    cssHeight: canvasCssHeight,
                    dpr: canvasDpr,
                    transform: transformDetails(transform),
                })
            }
            return
        }

        const dpr = canvasDpr
        ctx.setTransform(
            dpr * vt.scale * transform.k,
            0,
            0,
            dpr * vt.scale * transform.k,
            dpr * (vt.offsetX + transform.x * vt.scale),
            dpr * (vt.offsetY + transform.y * vt.scale)
        )

        const viewport = visibleViewport()
        const half = square_size / 2
        const xMinVisible = (viewport.xMin - transform.x) / transform.k - half
        const xMaxVisible = (viewport.xMax - transform.x) / transform.k + half
        const yMinVisible = (viewport.yMin - transform.y) / transform.k - half
        const yMaxVisible = (viewport.yMax - transform.y) / transform.k + half

        let drawnCells = 0
        const testedCells = 0
        const visibleColorGroups = 0
        const fillStyleChanges = 0
        const cellRenderer = 'raster'
        let cellRasterBuildMs = 0
        let cellRasterRebuilt = false
        let cellRasterScale = null
        let cellRasterPixels = 0
        const cellScreenPx = square_size * vt.scale * transform.k
        const cellsStart = svgPerf ? perfNow() : 0
        if (colorGroups.length || colorTransition) {
            const rasterResult = ensureCellRaster()
            const raster = rasterResult.raster
            cellRasterBuildMs = rasterResult.buildMs
            cellRasterRebuilt = rasterResult.rebuilt
            cellRasterScale = raster.scale
            cellRasterPixels = raster.width * raster.height
            ctx.imageSmoothingEnabled = false
            if (colorTransition) {
                const progress = colorTransitionProgress(colorTransition)
                if (progress >= 1) {
                    colorTransition = null
                    ctx.drawImage(raster.canvas, raster.modelX, raster.modelY, raster.modelWidth, raster.modelHeight)
                } else {
                    const eased = d3.easeCubicInOut(progress)
                    const from = colorTransition.from
                    ctx.globalCompositeOperation = 'lighter'
                    ctx.globalAlpha = 1 - eased
                    ctx.drawImage(from.canvas, from.modelX, from.modelY, from.modelWidth, from.modelHeight)
                    ctx.globalAlpha = eased
                    ctx.drawImage(raster.canvas, raster.modelX, raster.modelY, raster.modelWidth, raster.modelHeight)
                    ctx.globalAlpha = 1
                    ctx.globalCompositeOperation = 'source-over'
                }
            } else {
                ctx.drawImage(raster.canvas, raster.modelX, raster.modelY, raster.modelWidth, raster.modelHeight)
            }
            drawnCells = numRows
        }
        const cellsMs = svgPerf ? perfNow() - cellsStart : 0

        let drawnBorders = 0
        const bordersStart = svgPerf ? perfNow() : 0
        if (draw_country_borders && borderLines.length) {
            ctx.beginPath()
            for (const line of borderLines) {
                const bxMin = Math.min(line.x1, line.x2)
                const bxMax = Math.max(line.x1, line.x2)
                const byMin = Math.min(line.y1, line.y2)
                const byMax = Math.max(line.y1, line.y2)
                if (bxMax < xMinVisible || bxMin > xMaxVisible || byMax < yMinVisible || byMin > yMaxVisible) continue
                ctx.moveTo(line.x1, line.y1)
                ctx.lineTo(line.x2, line.y2)
                drawnBorders++
            }
            ctx.strokeStyle = country_border_color
            ctx.lineWidth = country_border_width
            ctx.stroke()
        }
        const bordersMs = svgPerf ? perfNow() - bordersStart : 0

        let drawnLabels = 0
        const screenFontPx = font_size * vt.scale * transform.k
        let labelSkipReason = null
        const labelsStart = svgPerf ? perfNow() : 0
        if (labelCount && screenFontPx >= label_min_screen_px) {
            ctx.font = `${font_size}px ${font_face}`
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.lineJoin = 'round'
            ctx.lineWidth = 2
            ctx.strokeStyle = 'white'
            ctx.fillStyle = text_color
            for (const i of labeledIndices) {
                const cx = cellX[i]
                const cy = cellY[i]
                if (cx < xMinVisible || cx > xMaxVisible || cy < yMinVisible || cy > yMaxVisible) continue
                ctx.save()
                ctx.translate(cx, cy)
                ctx.rotate(labelAngles[i])
                ctx.strokeText(labelCol[i], 0, 0)
                ctx.fillText(labelCol[i], 0, 0)
                ctx.restore()
                drawnLabels++
                if (drawnLabels >= max_canvas_labels) break
            }
        } else if (!labelCount) {
            labelSkipReason = 'no-labels'
        } else {
            labelSkipReason = 'too-small'
        }
        const labelsMs = svgPerf ? perfNow() - labelsStart : 0

        const highlightStart = svgPerf ? perfNow() : 0
        if (highlightedIndices.length) {
            ctx.strokeStyle = "orange"
            ctx.lineWidth = 1
            for (const i of highlightedIndices) {
                ctx.strokeRect(cellX[i] - half, cellY[i] - half, square_size, square_size)
            }
        }
        const highlightMs = svgPerf ? perfNow() - highlightStart : 0

        if (svgPerf) {
            const drawMs = perfNow() - drawStart
            recordSvgPerfDraw(drawMs, drawnCells, drawnBorders, drawnLabels)
            logSvgPerfDrawFrame({
                drawMs,
                resizeMs,
                clearMs,
                cellsMs,
                bordersMs,
                labelsMs,
                highlightMs,
                cellRenderer,
                cellScreenPx,
                cellRasterBuildMs,
                cellRasterRebuilt,
                cellRasterScale,
                cellRasterPixels,
                cellRasterFootprint: cellRaster ? cellRaster.footprint : null,
                cellRasterModel: cellRaster ? {x: cellRaster.modelX, y: cellRaster.modelY, width: cellRaster.modelWidth, height: cellRaster.modelHeight} : null,
                drawnCells,
                testedCells,
                colorGroups: colorGroups.length,
                visibleColorGroups,
                fillStyleChanges,
                drawnBorders,
                drawnLabels,
                labelCount,
                labelSkipReason,
                screenFontPx,
                visibleBounds: {xMin: xMinVisible, xMax: xMaxVisible, yMin: yMinVisible, yMax: yMaxVisible},
                resized,
                cssWidth: canvasCssWidth,
                cssHeight: canvasCssHeight,
                dpr: canvasDpr,
                transform: transformDetails(transform),
            })
        }
    }

    function writeTransform(transform) {
        latestTransform = transform
        drawCanvas(transform)
    }

    function applyPendingTransform() {
        transformRaf = null
        if (!pendingTransform) return
        const transform = pendingTransform
        pendingTransform = null
        writeTransform(transform)
    }

    function scheduleTransform(transform) {
        latestTransform = transform
        pendingTransform = transform
        if (typeof requestAnimationFrame !== 'function') {
            applyPendingTransform()
            return
        }
        if (transformRaf === null) transformRaf = requestAnimationFrame(applyPendingTransform)
    }

    function flushTransform() {
        if (transformRaf !== null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(transformRaf)
            transformRaf = null
        }
        applyPendingTransform()
    }

    const tooltip = root.append("div")
        .attr("class", "cartogram-tooltip")
        .style("display", "none")

    function hideTooltip() {
        tooltip.style("display", "none")
    }

    function formatTooltip(i) {
        const rows = []
        for (const key of Object.keys(currentData)) {
            const val = currentData[key][i]
            let displayVal = val
            if (key === 'index' && typeof val === 'string') {
                const parts = val.split(", ").filter(x => x)
                displayVal = parts.length > 3
                    ? `${parts.slice(0, 3).join(", ")}, … (${parts.length})`
                    : val
            } else if (typeof val === 'number') {
                displayVal = parseFloat(val.toPrecision(3)).toLocaleString()
            }
            if (displayVal != null && displayVal !== '') rows.push(`<div><strong>${escapeHtml(key)}:</strong> ${escapeHtml(displayVal)}</div>`)
        }
        return rows.join("")
    }

    function cellIndexFromEvent(event) {
        const point = canvasToViewBox(event)
        const transform = latestTransform || d3.zoomIdentity
        const modelX = (point.x - transform.x) / transform.k
        const modelY = (point.y - transform.y) / transform.k
        const rawX = center_x + (modelX - width / 2) * 2 / square_size
        const rawY = center_y + (modelY - height / 2) * 2 / square_size
        const oldSnappedX = minX + Math.round((rawX - minX) / coord_step) * coord_step
        const oldSnappedY = minY + Math.round((rawY - minY) / coord_step) * coord_step
        const details = {
            client: {x: event.clientX, y: event.clientY},
            point,
            model: {x: modelX, y: modelY},
            raw: {x: rawX, y: rawY},
            snapped: {x: oldSnappedX, y: oldSnappedY},
            transform: transformDetails(transform),
        }
        let best = null
        let candidates = 0
        for (let x = Math.floor(rawX) - 1; x <= Math.ceil(rawX) + 1; x++) {
            for (let y = Math.floor(rawY) - 1; y <= Math.ceil(rawY) + 1; y++) {
                const i = rowByCell.get(cellKey(x, y))
                if (i == null) continue
                candidates++
                const dx = Math.abs(modelX - cellX[i])
                const dy = Math.abs(modelY - cellY[i])
                const dist = dx * dx + dy * dy
                if (!best || dist < best.dist) best = {i, x, y, dx, dy, dist}
            }
        }
        if (!best) return {i: null, reason: 'no-cell', details: {...details, candidates}}
        if (best.dx > square_size / 2 || best.dy > square_size / 2) {
            return {i: null, reason: 'outside-cell', details: {...details, row: best.i, cell: {x: best.x, y: best.y}, dx: best.dx, dy: best.dy, candidates}}
        }
        return {i: best.i, reason: 'hit', details: {...details, row: best.i, cell: {x: best.x, y: best.y}, dx: best.dx, dy: best.dy, candidates}}
    }

    function hoveredCellIndexFromEvent(event) {
        return cellIndexFromEvent(event).i
    }

    function logClickEvent(event, hit) {
        debugLog('click.hit_test', {
            defaultPrevented: event.defaultPrevented,
            button: event.button,
            target: event.target ? event.target.tagName : null,
            reason: hit.reason,
            row: hit.i,
            dataRows: numRows,
            ...hit.details,
        })
    }

    let hoveredCellIndex = null
    canvasSelection.on("click.cell", (event) => {
        const hit = cellIndexFromEvent(event)
        logClickEvent(event, hit)
        if (event.defaultPrevented) {
            debugLog('click.skip_default_prevented', {row: hit.i, reason: hit.reason})
            return
        }
        if (hit.i != null) onclick_callback(currentData, event, hit.i)
    })
    canvasSelection.on("mousemove.cell", (event) => {
        if (cartogramGestureActive || fitToBoundsActive) {
            recordSvgPerfTooltip('suppressed')
            hideTooltip()
            hoveredCellIndex = null
            return
        }
        const i = hoveredCellIndexFromEvent(event)
        if (i == null) {
            if (hoveredCellIndex != null) recordSvgPerfTooltip('mouseleave')
            hoveredCellIndex = null
            hideTooltip()
            return
        }
        if (i !== hoveredCellIndex) {
            hoveredCellIndex = i
            recordSvgPerfTooltip('mouseenter')
            tooltip.html(formatTooltip(i)).style("display", "block")
        } else {
            recordSvgPerfTooltip('mousemove')
        }
        tooltip.style("left", (event.pageX + 12) + "px")
            .style("top", (event.pageY - 12) + "px")
    })
    canvasSelection.on("mouseleave.cell", () => {
        if (hoveredCellIndex != null) recordSvgPerfTooltip('mouseleave')
        hoveredCellIndex = null
        hideTooltip()
    })

    const zoom = d3.zoom().scaleExtent([0.5, 100])
        .on("start", (e) => {
            const source = e.sourceEvent
            cartogramGestureActive = !!source && canvas.contains(source.target)
            cartogramGestureMoved = false
            hoveredCellIndex = null
            hideTooltip()
            startSvgPerfGesture(e, cssToViewTransform(e.transform))
        })
        .on("zoom", (e) => {
            const handlerStart = svgPerf ? perfNow() : 0
            scheduleTransform(cssToViewTransform(e.transform))
            if (svgPerf) recordSvgPerfZoom(perfNow() - handlerStart)
            if (fitToBoundsActive) return
            if (cartogramGestureActive && e.sourceEvent) cartogramGestureMoved = true
        })
        .on("end", (e) => {
            flushTransform()
            const gestureMoved = cartogramGestureMoved
            endSvgPerfGesture({
                endSourceEventType: e.sourceEvent ? e.sourceEvent.type : null,
                moved: gestureMoved,
            })
            const viewChanged = fitToBoundsActive || (cartogramGestureActive && cartogramGestureMoved)
            const visible = viewChanged && latestTransform ? visibleIndices(latestTransform) : null
            if (visible && onviewchange_callback) onviewchange_callback(currentData, visible, e.sourceEvent)
            if (!fitToBoundsActive && onmove_callback && cartogramGestureActive && cartogramGestureMoved && visible) {
                debugLog('zoom.end', {
                    sourceEventType: e.sourceEvent ? e.sourceEvent.type : null,
                    visible: visible.length,
                    transform: transformDetails(latestTransform),
                })
                onmove_callback(currentData, visible, e.sourceEvent)
            }
            cartogramGestureActive = false
            cartogramGestureMoved = false
        })
    canvasSelection.call(zoom)

    if (typeof ResizeObserver !== 'undefined') {
        const resizeObserver = new ResizeObserver(() => scheduleTransform(latestTransform))
        resizeObserver.observe(root.node())
    } else {
        window.addEventListener('resize', () => scheduleTransform(latestTransform))
    }

    drawCanvas(latestTransform)
    doneRender()
    svgPerfLog('nodes', {
        renderer: 'canvas',
        canvas: 1,
        labels: 0,
        canvasLabels: labelCount,
        total: 1,
        cellShapes: numRows,
        borderSegments: borderLines.length,
        cellEventListeners: 0,
        delegatedEventListeners: 4,
    })

    function stopMovement() {
        fitToBoundsActive = false
        cartogramGestureActive = false
        cartogramGestureMoved = false
        canvasSelection.interrupt()
        hideTooltip()
    }

    function moveBy([x, y], factor) {
        let transform = d3.zoomTransform(canvas)
        transform = transform.translate(-x / transform.k, -y / transform.k)
        const k = Math.min(100, Math.max(0.5, transform.k * factor))
        if (k !== transform.k) {
            const ratio = k / transform.k
            const center = [canvas.clientWidth / 2, canvas.clientHeight / 2]
            transform = d3.zoomIdentity
                .translate(center[0] - (center[0] - transform.x) * ratio, center[1] - (center[1] - transform.y) * ratio)
                .scale(k)
        }
        canvasSelection.call(zoom.transform, transform)
    }

    function finishMovement() {
        flushTransform()
        const sourceEvent = {type: 'keyboard', target: canvas}
        const visible = visibleIndices(latestTransform)
        onviewchange_callback(currentData, visible, sourceEvent)
        onmove_callback(currentData, visible, sourceEvent)
    }

    return {
        updateData: (newData, newDataCol) => {
            const doneUpdate = perfTimer('update_data', {rows: newData.x ? newData.x.length : 0})
            currentData = newData
            if (newDataCol !== undefined) currentDataCol = newDataCol
            const col = currentData[currentDataCol]
            if (!col) {
                console.warn(`Column "${currentDataCol}" not found in updateData`)
                doneUpdate({missingColumn: currentDataCol})
                return
            }
            updateColorsWithTransition(col)
            doneUpdate()
        },
        highlightCells: (indices) => {
            const doneHighlight = perfTimer('highlight_cells', {rows: numRows, highlighted: indices.length})
            highlightedIndices = indices
            drawCanvas(latestTransform)
            doneHighlight()
        },
        stop: stopMovement,
        moveBy,
        finishMove: finishMovement,
        fitToBounds: ([[x1, y1, x2, y2]], duration = 500) => {
            const doneFit = perfTimer('fit_to_bounds')
            const left = getX(x1)
            const right = getX(x2)
            const top = getY(y1)
            const bottom = getY(y2)
            const boxW = right - left
            const boxH = bottom - top
            if (boxW <= 0 || boxH <= 0) {
                doneFit({skipped: true})
                return
            }
            const viewport = visibleViewport()
            const viewportWidth = viewport.xMax - viewport.xMin
            const viewportHeight = viewport.yMax - viewport.yMin
            const pad = 20
            const k = Math.min((viewportWidth - 2 * pad) / boxW, (viewportHeight - 2 * pad) / boxH)
            const cx = (left + right) / 2
            const cy = (top + bottom) / 2
            const viewportCx = (viewport.xMin + viewport.xMax) / 2
            const viewportCy = (viewport.yMin + viewport.yMax) / 2
            const fitToken = ++fitToBoundsToken
            fitToBoundsActive = true
            const transform = d3.zoomIdentity.translate(viewportCx - cx * k, viewportCy - cy * k).scale(k)
            const cssTransform = viewToCssTransform(transform)
            debugLog('fit_to_bounds', {
                inputBounds: [[x1, y1, x2, y2]],
                viewport,
                box: {left, right, top, bottom, boxW, boxH},
                transform: transformDetails(transform),
                duration,
            })
            svgPerfLog('fit_to_bounds.request', {
                inputBounds: [[x1, y1, x2, y2]],
                viewport,
                box: {left, right, top, bottom, boxW, boxH},
                viewTransform: transformDetails(transform),
                cssTransform: transformDetails(cssTransform),
                latestTransform: transformDetails(latestTransform),
                duration,
                cssWidth: canvasCssWidth,
                cssHeight: canvasCssHeight,
                dpr: canvasDpr,
            })
            doneFit({duration})
            canvasSelection.transition().duration(duration)
                .call(zoom.transform, cssTransform)
                .on("end", () => {
                    if (fitToken === fitToBoundsToken) fitToBoundsActive = false
                    svgPerfLog('fit_to_bounds.end', {latestTransform: transformDetails(latestTransform)})
                })
                .on("interrupt", () => {
                    if (fitToken === fitToBoundsToken) fitToBoundsActive = false
                    svgPerfLog('fit_to_bounds.interrupt', {latestTransform: transformDetails(latestTransform)})
                })
        }
    }
}
