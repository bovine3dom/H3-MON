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
        
        get_color = (z) => d3.scaleSequential(d3.interpolateSpectral).domain([0,1])(z) ?? 'rgba(255,255,255,0)',
        onclick_callback = console.log,
        onmove_callback = () => {},
    } = options

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

    let movePending = false
    let latestTransform = null
    let fitToBoundsActive = false
    const zoom = d3.zoom().scaleExtent([0.5, 100]).on("zoom", (e) => {
        g.attr("transform", e.transform)
        labelsG.attr("transform", e.transform)
        if (fitToBoundsActive) return
        if (onmove_callback) {
            latestTransform = e.transform
            if (!movePending) {
                movePending = true
                requestAnimationFrame(() => {
                    movePending = false
                    const t = latestTransform
                    const visible = []
                    for (let i = 0; i < numRows; i++) {
                        const cx = getX(xCol[i])
                        const cy = getY(yCol[i])
                        const halfExtent = square_size * t.k / 2
                        const sx = cx * t.k + t.x
                        const sy = cy * t.k + t.y
                        if (sx + halfExtent >= 0 && sx - halfExtent <= width &&
                            sy + halfExtent >= 0 && sy - halfExtent <= height) {
                            visible.push(i)
                        }
                    }
                    onmove_callback(currentData, visible)
                })
            }
        }
    })
    svg.call(zoom)

    const cellMap = new Map()
    for (let i = 0; i < numRows; i++) {
        cellMap.set(`${xCol[i]},${yCol[i]}`, codeCol[i])
    }

    const rowIndices = d3.range(numRows)
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
    }

    if (labelCol) {
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
    }

    return {
        updateData: (newData, newDataCol) => {
            currentData = newData
            if (newDataCol !== undefined) currentDataCol = newDataCol
            const col = currentData[currentDataCol]
            if (!col) {
                console.warn(`Column "${currentDataCol}" not found in updateData`)
                return
            }
            cells.attr("fill", i => get_color(col[i]))
        },
        highlightCells: (indices) => {
            cells.attr("stroke", i => indices.includes(i) ? "orange" : (draw_outline ? outline_color : "none"))
                .attr("stroke-width", i => indices.includes(i) ? 1 : (draw_outline ? outline_width : 0))
            indices.forEach(i => {
                const node = cells.nodes()[i]
                if (node) node.parentNode.appendChild(node)
            })
        },
        fitToBounds: ([[x1, y1, x2, y2]], duration = 500) => {
            const left = getX(x1)
            const right = getX(x2)
            const top = getY(y1)
            const bottom = getY(y2)
            const boxW = right - left
            const boxH = bottom - top
            if (boxW <= 0 || boxH <= 0) return
            const pad = 20
            const k = Math.min((width - 2 * pad) / boxW, (height - 2 * pad) / boxH)
            const cx = (left + right) / 2
            const cy = (top + bottom) / 2
            fitToBoundsActive = true
            svg.transition().duration(duration)
                .call(zoom.transform, d3.zoomIdentity.translate(width / 2 - cx * k, height / 2 - cy * k).scale(k))
                .on("end", () => { fitToBoundsActive = false })
        }
    }
}
