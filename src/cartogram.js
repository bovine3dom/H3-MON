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
        draw_outline = true,
        outline_color = "black",
        outline_width = 0.5,
        draw_country_borders = true,
        country_border_color = "black",
        country_border_width = 1.5,
        include_outer_borders = false,
        font_size = 8,
        font_face = "Iosevka, monospace",
        text_color = "black",
        data_col = 'code',
        perf = false,
        svgPerf = false,
        debug = false,
        get_color = defaultGetColour,
        onclick_callback = console.log,
        onmove_callback = () => {},
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
    const canvas = root.append("canvas")
        .style("position", "absolute")
        .style("inset", "0")
        .style("width", "100%")
        .style("height", "100%")
        .style("display", "block")
        .node()
    const ctx = canvas.getContext('2d')
    const svg = root.append("svg")
        .attr("width", "100%")
        .attr("height", "100%")
        .attr("viewBox", `0 0 ${width} ${height}`)
        .attr("preserveAspectRatio", "xMidYMid slice")
        .style("position", "absolute")
        .style("inset", "0")
    const labelsG = svg.append("g")
    doneCreate()

    const cellKey = (x, y) => `${x},${y}`
    const rowByCell = new Map()
    const codeByCell = new Map()
    const cellX = new Float32Array(numRows)
    const cellY = new Float32Array(numRows)
    let colors = new Array(numRows)
    let borderLines = []
    let labelNodeCount = 0
    let highlightedIndices = []
    let latestTransform = d3.zoomIdentity
    let fitToBoundsActive = false
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
        for (let i = 0; i < numRows; i++) colors[i] = get_color(col[i]) ?? TRANSPARENT_COLOUR
        doneColors()
    }
    updateColors(currentData[currentDataCol])

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

    function recordSvgPerfDraw(drawMs, drawnCells, drawnBorders) {
        if (!svgPerfGesture) return
        svgPerfGesture.transformWrites++
        svgPerfGesture.drawTotalMs += drawMs
        if (drawMs > svgPerfGesture.maxDrawMs) svgPerfGesture.maxDrawMs = drawMs
        svgPerfGesture.drawnCellTotal += drawnCells
        if (drawnCells > svgPerfGesture.maxDrawnCells) svgPerfGesture.maxDrawnCells = drawnCells
        svgPerfGesture.drawnBorderTotal += drawnBorders
    }

    function recordSvgPerfTooltip(kind) {
        if (svgPerfGesture && svgPerfGesture.tooltipEvents[kind] !== undefined) svgPerfGesture.tooltipEvents[kind]++
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
                labels: labelNodeCount,
                total: 1 + 1 + labelNodeCount,
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
        resizeCanvas()
        const vt = viewTransform()
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        if (!canvasCssWidth || !canvasCssHeight) return

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
        let lastFill = null
        for (let i = 0; i < numRows; i++) {
            const cx = cellX[i]
            const cy = cellY[i]
            if (cx < xMinVisible || cx > xMaxVisible || cy < yMinVisible || cy > yMaxVisible) continue
            const fill = colors[i]
            if (fill !== lastFill) {
                ctx.fillStyle = fill
                lastFill = fill
            }
            ctx.fillRect(cx - half, cy - half, square_size, square_size)
            if (draw_outline) {
                ctx.strokeStyle = outline_color
                ctx.lineWidth = outline_width
                ctx.strokeRect(cx - half, cy - half, square_size, square_size)
            }
            drawnCells++
        }

        let drawnBorders = 0
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

        if (highlightedIndices.length) {
            ctx.strokeStyle = "orange"
            ctx.lineWidth = 1
            for (const i of highlightedIndices) {
                ctx.strokeRect(cellX[i] - half, cellY[i] - half, square_size, square_size)
            }
        }

        if (svgPerf) recordSvgPerfDraw(perfNow() - drawStart, drawnCells, drawnBorders)
    }

    function writeTransform(transform) {
        latestTransform = transform
        labelsG.attr("transform", transform)
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
        const x = minX + Math.round((rawX - minX) / coord_step) * coord_step
        const y = minY + Math.round((rawY - minY) / coord_step) * coord_step
        const i = rowByCell.get(cellKey(x, y))
        if (i == null) return null
        if (Math.abs(modelX - cellX[i]) > square_size / 2 || Math.abs(modelY - cellY[i]) > square_size / 2) return null
        return i
    }

    let hoveredCellIndex = null
    svg.on("click.cell", (event) => {
        if (event.defaultPrevented) return
        const i = cellIndexFromEvent(event)
        if (i != null) onclick_callback(currentData, event, i)
    })
    svg.on("mousemove.cell", (event) => {
        if (cartogramGestureActive || fitToBoundsActive) {
            recordSvgPerfTooltip('suppressed')
            hideTooltip()
            hoveredCellIndex = null
            return
        }
        const i = cellIndexFromEvent(event)
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
    svg.on("mouseleave.cell", () => {
        if (hoveredCellIndex != null) recordSvgPerfTooltip('mouseleave')
        hoveredCellIndex = null
        hideTooltip()
    })

    if (labelCol) {
        const doneLabels = perfTimer('labels.render', {rows: numRows})
        const rowIndices = d3.range(numRows)
        const labeledIndices = rowIndices.filter(i => {
            const label = labelCol[i]
            return label !== null && label !== undefined && label !== ""
        })
        labelsG.selectAll(".label")
            .data(labeledIndices)
            .join("text")
            .attr("class", "label")
            .attr("x", i => cellX[i])
            .attr("y", i => cellY[i])
            .attr("transform", i => `rotate(${(Math.random() * 90) - 45}, ${cellX[i]}, ${cellY[i]})`)
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central")
            .attr("font-size", `${font_size}px`)
            .attr("font-family", font_face)
            .attr("fill", text_color)
            .attr("stroke", "white")
            .attr("stroke-width", "2")
            .attr("stroke-linejoin", "round")
            .attr("paint-order", "stroke fill")
            .text(i => labelCol[i])
            .style("pointer-events", "none")
        labelNodeCount = labeledIndices.length
        doneLabels({labels: labelNodeCount})
    }

    const zoom = d3.zoom().scaleExtent([0.5, 100])
        .on("start", (e) => {
            const source = e.sourceEvent
            const svgNode = svg.node()
            cartogramGestureActive = !!source && !!svgNode && svgNode.contains(source.target)
            cartogramGestureMoved = false
            hoveredCellIndex = null
            hideTooltip()
            startSvgPerfGesture(e, e.transform)
        })
        .on("zoom", (e) => {
            const handlerStart = svgPerf ? perfNow() : 0
            scheduleTransform(e.transform)
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
            if (!fitToBoundsActive && onmove_callback && cartogramGestureActive && cartogramGestureMoved && latestTransform) {
                const visible = visibleIndices(latestTransform)
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
    svg.call(zoom)

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
        labels: labelNodeCount,
        total: 1 + 1 + labelNodeCount,
        cellShapes: numRows,
        borderSegments: borderLines.length,
        cellEventListeners: 0,
        delegatedEventListeners: 4,
    })

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
            updateColors(col)
            drawCanvas(latestTransform)
            doneUpdate()
        },
        highlightCells: (indices) => {
            const doneHighlight = perfTimer('highlight_cells', {rows: numRows, highlighted: indices.length})
            highlightedIndices = indices
            drawCanvas(latestTransform)
            doneHighlight()
        },
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
            fitToBoundsActive = true
            const transform = d3.zoomIdentity.translate(viewportCx - cx * k, viewportCy - cy * k).scale(k)
            debugLog('fit_to_bounds', {
                inputBounds: [[x1, y1, x2, y2]],
                viewport,
                box: {left, right, top, bottom, boxW, boxH},
                transform: transformDetails(transform),
                duration,
            })
            doneFit({duration})
            svg.transition().duration(duration)
                .call(zoom.transform, transform)
                .on("end", () => { fitToBoundsActive = false })
                .on("interrupt", () => { fitToBoundsActive = false })
        }
    }
}
