// Approximate the area covered by a round, one-cell-wide straight stroke.
export function strokeCoverage(xs, ys, start, end, cellSize = 2) {
    const covered = new Map(), samples = 4, radius = cellSize / 2
    const dx = end[0] - start[0], dy = end[1] - start[1], length2 = dx * dx + dy * dy
    for (let cell = 0; cell < xs.length; cell++) {
        const x = Number(xs[cell]), y = Number(ys[cell])
        if (x < Math.min(start[0], end[0]) - cellSize || x > Math.max(start[0], end[0]) + cellSize
            || y < Math.min(start[1], end[1]) - cellSize || y > Math.max(start[1], end[1]) + cellSize) continue
        let hits = 0
        for (let i = 0; i < samples; i++) for (let j = 0; j < samples; j++) {
            const px = x + ((i + 0.5) / samples - 0.5) * cellSize
            const py = y + ((j + 0.5) / samples - 0.5) * cellSize
            const t = length2 ? Math.max(0, Math.min(1, ((px - start[0]) * dx + (py - start[1]) * dy) / length2)) : 0
            if ((px - start[0] - t * dx) ** 2 + (py - start[1] - t * dy) ** 2 <= radius ** 2) hits++
        }
        if (hits) covered.set(cell, hits / (samples * samples))
    }
    return covered
}

export function projectStroke(coverage, rowsByCell, weightAt, indexAt) {
    const weights = new Map()
    for (const [cell, fraction] of coverage) for (const row of rowsByCell[cell] || []) {
        const weight = Number(weightAt(row))
        if (!(weight > 0 && Number.isFinite(weight))) continue
        const index = indexAt(row)
        weights.set(index, (weights.get(index) || 0) + fraction * weight)
    }
    return Array.from(weights, ([index, weight]) => ({index, weight}))
}

export function createLineProbe(canvas, {enabled, begin, point, change, redraw}) {
    let stroke = null, pointer = null, frame = null, suppressClick = false
    const hint = document.createElement('div')
    hint.className = 'cartogram-line-hint'
    hint.hidden = !enabled()
    hint.textContent = 'Shift-drag: geographic footprint · Esc: clear'
    Object.assign(hint.style, {position: 'absolute', bottom: '8px', left: '8px', pointerEvents: 'none',
        background: '#ffffffdd', color: '#111', font: '12px sans-serif', padding: '4px'})
    canvas.parentElement.append(hint)
    canvas.tabIndex = -1
    function publish() {
        if (frame !== null) cancelAnimationFrame(frame)
        frame = null
        change(stroke)
        redraw()
    }
    function release() {
        const captured = pointer
        pointer = null
        if (captured !== null && canvas.hasPointerCapture(captured)) canvas.releasePointerCapture(captured)
    }
    function clear() {
        stroke = null
        release()
        publish()
    }
    function down(event) {
        suppressClick = false
        if (!enabled() || !event.shiftKey || event.button !== 0 || pointer !== null) return
        event.preventDefault()
        event.stopImmediatePropagation()
        begin()
        canvas.focus({preventScroll: true})
        pointer = event.pointerId
        canvas.setPointerCapture(pointer)
        suppressClick = true
        stroke = [point(event), point(event)]
        publish()
    }
    function move(event) {
        if (event.pointerId !== pointer) return
        event.preventDefault()
        stroke[1] = point(event)
        if (frame === null) frame = requestAnimationFrame(publish)
    }
    function up(event) {
        if (event.pointerId !== pointer) return
        stroke[1] = point(event)
        release()
        publish()
    }
    function cancel(event) {
        if (event.pointerId === pointer) clear()
    }
    function click(event) {
        if (!suppressClick && !(enabled() && event.shiftKey)) return
        event.preventDefault()
        event.stopImmediatePropagation()
        suppressClick = false
    }
    function key(event) {
        if (event.key !== 'Escape' || !stroke) return
        event.preventDefault()
        event.stopPropagation()
        clear()
    }
    const handlers = {pointerdown: down, pointermove: move, pointerup: up,
        pointercancel: cancel, lostpointercapture: cancel, click, keydown: key}
    for (const [type, handler] of Object.entries(handlers)) canvas.addEventListener(type, handler, true)
    return {
        get active() { return pointer !== null },
        clear,
        draw(ctx, project, width) {
            hint.hidden = !enabled()
            if (!stroke || !enabled()) return
            const [start, end] = stroke.map(project)
            ctx.save()
            ctx.beginPath()
            ctx.moveTo(...start)
            ctx.lineTo(...end)
            ctx.strokeStyle = '#0096ff'
            ctx.lineCap = 'round'
            ctx.lineWidth = width
            ctx.globalAlpha = 0.25
            ctx.stroke()
            ctx.lineWidth = width / 8
            ctx.globalAlpha = 1
            ctx.stroke()
            ctx.restore()
        },
        destroy() {
            for (const [type, handler] of Object.entries(handlers)) canvas.removeEventListener(type, handler, true)
            if (frame !== null) cancelAnimationFrame(frame)
            release()
            hint.remove()
            if (stroke) change(null)
        },
    }
}
