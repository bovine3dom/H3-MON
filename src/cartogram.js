import * as d3 from 'd3'

export function render_cartogram(container, data, options = {}) {
    const {
        square_size = 10,
        coord_step = 2,
        padding = 20,
        
        // outline styling
        draw_outline = true,
        outline_color = "black",
        outline_width = 0.5,
        
        // country border styling
        draw_country_borders = true,
        country_border_color = "black",
        country_border_width = 1.5,
        include_outer_borders = false,
        
        // label styling
        font_size = 8,
        font_face = "Iosevka, monospace",
        text_color = "black",
        
        // data
        data_col = 'code',
        perf = false,
        debug = false,
        
        get_color = (z) => d3.scaleSequential(d3.interpolateSpectral).domain([0,1])(z) ?? 'rgba(255,255,255,0)',
        onclick_callback = console.log,
        onmove_callback = () => {},
    } = options

    const perfNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())
    function perfTimer(label, details) {
        if (!perf) return () => {}
        const start = perfNow()
        return (extra) => {
            const elapsed = perfNow() - start
            const merged = {...(details || {}), ...(extra || {})}
            if (Object.keys(merged).length) {
                console.info(`[perf] cartogram.svg.${label}: ${elapsed.toFixed(1)}ms`, merged)
            } else {
                console.info(`[perf] cartogram.svg.${label}: ${elapsed.toFixed(1)}ms`)
            }
        }
    }
    function debugLog(label, details) {
        if (debug) console.info(`[sync] cartogram.${label}`, details || {})
    }

    let currentData = data
    let currentDataCol = data_col

    const xCol = currentData.x
    const yCol = currentData.y
    const codeCol = currentData.code
    const dataCol = currentData[currentDataCol]
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
    doneLayout({width, height})

    const doneSvgCreate = perfTimer('svg.create')
    d3.select(container).selectAll("svg").remove()
    d3.select(container).selectAll(".cartogram-tooltip").remove()

    const svg = d3.select(container)
        .append("svg")
        .attr("width", "100%")
        .attr("height", "100%")
        .attr("viewBox", `0 0 ${width} ${height}`)
        .attr("preserveAspectRatio", "xMidYMid slice")

    const g = svg.append("g")
    const labelsG = svg.append("g")
    doneSvgCreate()

    let latestTransform = null
    let fitToBoundsActive = false
    let cartogramGestureActive = false
    let cartogramGestureMoved = false

    function visibleViewport() {
        const node = svg.node()
        const rect = node ? node.getBoundingClientRect() : null
        const viewport = {xMin: 0, yMin: 0, xMax: width, yMax: height}
        if (!rect || rect.width <= 0 || rect.height <= 0) return viewport

        const clientRatio = rect.width / rect.height
        const viewRatio = width / height
        if (clientRatio > viewRatio) {
            const visibleHeight = width / clientRatio
            viewport.yMin = (height - visibleHeight) / 2
            viewport.yMax = viewport.yMin + visibleHeight
        } else if (clientRatio < viewRatio) {
            const visibleWidth = height * clientRatio
            viewport.xMin = (width - visibleWidth) / 2
            viewport.xMax = viewport.xMin + visibleWidth
        }
        return viewport
    }

    function visibleIndices(transform) {
        const doneVisible = perfTimer('visible_indices', {rows: numRows})
        const viewport = visibleViewport()
        const visible = []
        for (let i = 0; i < numRows; i++) {
            const cx = getX(xCol[i])
            const cy = getY(yCol[i])
            const halfExtent = square_size * transform.k / 2
            const sx = cx * transform.k + transform.x
            const sy = cy * transform.k + transform.y
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
            transform: {x: transform.x, y: transform.y, k: transform.k},
            firstRows: visible.slice(0, 10),
        })
        return visible
    }

    const zoom = d3.zoom().scaleExtent([0.5, 100])
        .on("start", (e) => {
            const source = e.sourceEvent
            const svgNode = svg.node()
            cartogramGestureActive = !!source && !!svgNode && svgNode.contains(source.target)
            cartogramGestureMoved = false
        })
        .on("zoom", (e) => {
            g.attr("transform", e.transform)
            labelsG.attr("transform", e.transform)
            latestTransform = e.transform
            if (fitToBoundsActive) return
            if (cartogramGestureActive && e.sourceEvent) cartogramGestureMoved = true
        })
        .on("end", (e) => {
            if (!fitToBoundsActive && onmove_callback && cartogramGestureActive && cartogramGestureMoved && latestTransform) {
                const visible = visibleIndices(latestTransform)
                debugLog('zoom.end', {
                    sourceEventType: e.sourceEvent ? e.sourceEvent.type : null,
                    visible: visible.length,
                    transform: {x: latestTransform.x, y: latestTransform.y, k: latestTransform.k},
                })
                onmove_callback(currentData, visible, e.sourceEvent)
            }
            cartogramGestureActive = false
            cartogramGestureMoved = false
        })
    svg.call(zoom)

    const cellMap = new Map()
    const doneCellMap = perfTimer('cell_map.build', {rows: numRows})
    for (let i = 0; i < numRows; i++) {
        cellMap.set(`${xCol[i]},${yCol[i]}`, codeCol[i])
    }
    doneCellMap({cells: cellMap.size})

    const rowIndices = d3.range(numRows)
    const doneCells = perfTimer('cells.render', {rows: numRows})
    const cells = g.selectAll(".cell")
        .data(rowIndices)
        .join("rect")
        .attr("class", "cell")
        .attr("x", i => getX(xCol[i]) - square_size / 2)
        .attr("y", i => getY(yCol[i]) - square_size / 2)
        .attr("width", square_size)
        .attr("height", square_size)
        .attr("fill", i => get_color(currentData[currentDataCol][i]))
        .attr("stroke", draw_outline ? outline_color : "none")
        .attr("stroke-width", draw_outline ? outline_width : 0)
    doneCells()

    // Tooltip
    const tooltip = d3.select(container)
        .append("div")
        .attr("class", "cartogram-tooltip")
        .style("display", "none")

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
            if (displayVal != null && displayVal !== '') {
                rows.push(`<div><strong>${key}:</strong> ${displayVal}</div>`)
            }
        }
        return rows.join("")
    }

    cells.on("click", (event, i) => onclick_callback(currentData, event, i))
    cells.on("mouseenter", function(event, i) {
        tooltip.html(formatTooltip(i))
            .style("display", "block")
            .style("left", (event.pageX + 12) + "px")
            .style("top", (event.pageY - 12) + "px")
    })
    .on("mousemove", function(event) {
        tooltip.style("left", (event.pageX + 12) + "px")
            .style("top", (event.pageY - 12) + "px")
    })
    .on("mouseleave", function() {
        tooltip.style("display", "none")
    })

    if (draw_country_borders) {
        const doneBorders = perfTimer('borders.render', {rows: numRows})
        const borderLines = []

        for (let i = 0; i < numRows; i++) {
            const x = xCol[i]
            const y = yCol[i]
            const code = codeCol[i]
            const cx = getX(x)
            const cy = getY(y)

            const rCode = cellMap.get(`${x + coord_step},${y}`)
            if (rCode !== code && (include_outer_borders || rCode !== undefined)) {
                borderLines.push({
                    x1: cx + square_size / 2, y1: cy - square_size / 2,
                    x2: cx + square_size / 2, y2: cy + square_size / 2
                })
            }

            const bCode = cellMap.get(`${x},${y + coord_step}`)
            if (bCode !== code && (include_outer_borders || bCode !== undefined)) {
                borderLines.push({
                    x1: cx - square_size / 2, y1: cy + square_size / 2,
                    x2: cx + square_size / 2, y2: cy + square_size / 2
                })
            }

            if (include_outer_borders) {
                if (cellMap.get(`${x - coord_step},${y}`) === undefined) {
                    borderLines.push({
                        x1: cx - square_size / 2, y1: cy - square_size / 2,
                        x2: cx - square_size / 2, y2: cy + square_size / 2
                    })
                }
                if (cellMap.get(`${x},${y - coord_step}`) === undefined) {
                    borderLines.push({
                        x1: cx - square_size / 2, y1: cy - square_size / 2,
                        x2: cx + square_size / 2, y2: cy - square_size / 2
                    })
                }
            }
        }

        g.selectAll(".country-border")
            .data(borderLines)
            .join("line")
            .attr("class", "country-border")
            .attr("x1", d => d.x1)
            .attr("y1", d => d.y1)
            .attr("x2", d => d.x2)
            .attr("y2", d => d.y2)
            .attr("stroke", country_border_color)
            .attr("stroke-width", country_border_width)
        doneBorders({borders: borderLines.length})
    }

    if (labelCol) {
        const doneLabels = perfTimer('labels.render', {rows: numRows})
        const labeledIndices = rowIndices.filter(i => {
            const label = labelCol[i]
            return label !== null && label !== undefined && label !== ""
        })

        labelsG.selectAll(".label")
            .data(labeledIndices)
            .join("text")
            .attr("class", "label")
            .attr("x", i => getX(xCol[i]))
            .attr("y", i => getY(yCol[i]))
            .attr("transform", i => `rotate(${(Math.random() * 90) - 45}, ${getX(xCol[i])}, ${getY(yCol[i])})`)
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
        doneLabels({labels: labeledIndices.length})
    }

    doneRender()

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
            cells.attr("fill", i => get_color(col[i]))
            doneUpdate()
        },
        highlightCells: (indices) => {
            const doneHighlight = perfTimer('highlight_cells', {rows: numRows, highlighted: indices.length})
            cells.attr("stroke", i => indices.includes(i) ? "orange" : (draw_outline ? outline_color : "none"))
                .attr("stroke-width", i => indices.includes(i) ? 1 : (draw_outline ? outline_width : 0))
            indices.forEach(i => {
                const node = cells.nodes()[i]
                if (node) node.parentNode.appendChild(node)
            })
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
                transform: {x: transform.x, y: transform.y, k: transform.k},
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
