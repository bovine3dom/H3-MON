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
        font_face = "Iosevka", // todo: remember how fallbacks work for this
        text_color = "black",

        // data
        data_col = 'code',
        
        get_color = (z) => d3.scaleSequential(d3.interpolateSpectral).domain([0,1])(z),
        onclick_callback = console.log,
        onmove_callback = () => {},
    } = options

    const xCol = data.x
    const yCol = data.y
    const codeCol = data.code
    const dataCol = data[data_col]
    const labelCol = data.label

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

    const svg = d3.select(container)
        .append("svg")
        .attr("width", "100%")
        .attr("height", "100%")
        .attr("viewBox", `0 0 ${width} ${height}`)

    const g = svg.append("g")

    let movePending = false
    let latestTransform = null
    svg.call(d3.zoom().scaleExtent([0.5, 8]).on("zoom", (e) => {
        g.attr("transform", e.transform)
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
                    onmove_callback(data, visible)
                })
            }
        }
    }))

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
        .attr("fill", i => get_color(dataCol[i]))
        .attr("stroke", draw_outline ? outline_color : "none")
        .attr("stroke-width", draw_outline ? outline_width : 0)

    // Simple interactivity
    cells.on("click", (event, i) => onclick_callback(data, event, i))
    // cells.on("mousedown", function(event, i) {
    //     d3.select(this)
    //         .attr("stroke", "orange")
    //         .attr("stroke-width", 2)
            
    //     const labelText = labelCol ? labelCol[i] : null
    //     // showTooltip(event, `${labelText || 'Unknown'} (Code: ${codeCol[i]})`)
    //     console.log(event, labelText, codeCol[i])
    // }) // todo: replace when clicking elsewhere
    // .on("mouseout", function() {
    //     d3.select(this)
    //         .attr("stroke", draw_outline ? outline_color : "none")
    //         .attr("stroke-width", draw_outline ? outline_width : 0)
    //     // hideTooltip()
    // })

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

        g.selectAll(".label")
            .data(labeledIndices)
            .join("text")
            .attr("class", "label")
            .attr("x", i => getX(xCol[i]))
            .attr("y", i => getY(yCol[i]))
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "central")
            .attr("font-size", `${font_size}px`)
            .attr("font-family", font_face)
            .attr("fill", text_color)
            .text(i => labelCol[i])
            .style("pointer-events", "none")
    }
}
