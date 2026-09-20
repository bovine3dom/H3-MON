import './animation-timeline.css'

const element = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = text
    return node
}

export function humanReadableAnimationValue(value, type) {
    if (type === 'time' && typeof value === 'string') return value
    if (typeof value !== 'number' || !Number.isFinite(value)) return String(value ?? '')
    return value.toLocaleString(undefined, {maximumSignificantDigits: 12})
}

function labelIndices(count) {
    if (count <= 80) return Array.from({length: count}, (_, index) => index)
    const indices = new Set([0, count - 1])
    for (let i = 1; i < 10; i++) indices.add(Math.round((count - 1) * i / 10))
    return [...indices].sort((a, b) => a - b)
}

export function createAnimationTimeline({root, onPlay = () => {}, onSeek = () => {}, onSelect = () => {}}) {
    const selectorLabel = element('label', 'animation-timeline-selector')
    const selector = document.createElement('select')
    selector.setAttribute('aria-label', 'Animation control')
    const play = element('button', 'animation-timeline-play', '▶')
    play.type = 'button'
    const track = element('div', 'animation-timeline-track')
    const range = document.createElement('input')
    range.type = 'range'
    range.min = '0'
    range.step = '1'
    const labels = element('div', 'animation-timeline-labels')
    const error = element('span', 'animation-timeline-error')
    error.setAttribute('role', 'alert')
    selectorLabel.append(selector)
    track.append(range, labels)
    root.replaceChildren(play, selectorLabel, track, error)

    const attribution = document.getElementById('attribution')
    const resizeToLegend = () => {
        const parent = root.parentElement?.getBoundingClientRect()
        const legend = attribution?.getBoundingClientRect()
        if (parent && legend) root.style.setProperty('--animation-timeline-right', `${Math.max(0, parent.right - legend.left + 8)}px`)
        fitLabels()
    }
    const labelResizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitLabels)
    labelResizeObserver?.observe(labels)
    window.addEventListener('resize', resizeToLegend)
    resizeToLegend()

    let activeId = ''
    let currentState = null
    let currentType = 'number'
    let renderedAnimationsKey = ''
    let renderedStateKey = ''

    function fitLabels() {
        const nodes = [...labels.children]
        if (!nodes.length || !labels.clientWidth) return
        nodes.forEach(node => { node.style.display = '' })
        const gap = Number.parseFloat(getComputedStyle(labels).columnGap) || 0
        const widths = new Map(nodes.map(node => [node, node.scrollWidth]))
        const fits = selected => selected.reduce((width, node) => width + widths.get(node), 0) + gap * (selected.length - 1) <= labels.clientWidth
        const current = nodes.findIndex(node => node.classList.contains('current'))
        const choose = count => {
            if (count === 1) return [nodes[current < 0 ? 0 : current]]
            const chosen = new Set([0, nodes.length - 1])
            if (count > 2 && current > 0 && current < nodes.length - 1) chosen.add(current)
            for (let i = 1; i < count - 1; i++) chosen.add(Math.round((nodes.length - 1) * i / (count - 1)))
            for (let index = 1; chosen.size < count && index < nodes.length - 1; index++) chosen.add(index)
            return [...chosen].sort((a, b) => a - b).map(index => nodes[index])
        }
        for (let count = nodes.length; count > 0; count--) {
            const selected = choose(count)
            if (!fits(selected)) continue
            const visible = new Set(selected)
            nodes.forEach(node => { node.style.display = visible.has(node) ? '' : 'none' })
            return
        }
        nodes.forEach(node => { node.style.display = 'none' })
    }

    function writeValue(index) {
        if (!currentState?.sequence) return
        range.setAttribute('aria-valuetext', humanReadableAnimationValue(currentState.sequence.value(index), currentType))
        labels.querySelectorAll('[data-index]').forEach(node => node.classList.toggle('current', Number(node.dataset.index) === index))
        fitLabels()
    }

    function renderLabels(sequence, index) {
        labels.replaceChildren(...labelIndices(sequence.count).map(step => {
            const node = element('span', '', humanReadableAnimationValue(sequence.value(step), currentType))
            node.dataset.index = String(step)
            node.title = `Step ${step + 1} of ${sequence.count}`
            node.classList.toggle('current', step === index)
            return node
        }))
        fitLabels()
    }

    range.addEventListener('input', () => {
        const index = Number(range.value)
        writeValue(index)
        onSeek(activeId, index)
    })
    selector.addEventListener('change', () => onSelect(selector.value))
    play.addEventListener('click', () => onPlay(activeId))

    return {
        update({enabled = false, animations = [], activeId: nextId = '', playing = '', getState = () => null} = {}) {
            root.hidden = !enabled || !animations.length
            if (root.hidden) return
            if (!animations.some(animation => animation.id === nextId)) nextId = animations[0].id
            activeId = nextId
            const animationsKey = animations.map(animation => `${animation.id}:${animation.name}:${animation.type}`).join('|')
            if (animationsKey !== renderedAnimationsKey) {
                selector.replaceChildren(...animations.map(animation => {
                    const option = element('option', '', animation.name)
                    option.value = animation.id
                    return option
                }))
                renderedAnimationsKey = animationsKey
            }
            selector.value = activeId
            selectorLabel.hidden = animations.length < 2
            play.textContent = playing === activeId ? '⏸' : '▶'
            play.setAttribute('aria-label', `${playing === activeId ? 'Pause' : 'Play'} ${selector.options[selector.selectedIndex]?.text || 'animation'}`)
            currentState = null
            currentType = animations.find(animation => animation.id === activeId)?.type || 'number'
            error.textContent = ''
            try { currentState = getState(activeId) } catch (cause) { error.textContent = cause?.message || String(cause) }
            error.hidden = !error.textContent
            if (!currentState?.sequence) return
            const sequence = currentState.sequence
            const stateKey = `${activeId}:${currentState.key || `${sequence.count}:${sequence.value(0)}:${sequence.value(sequence.count - 1)}`}`
            const index = Math.max(0, Math.min(sequence.count - 1, currentState.index || 0))
            if (stateKey !== renderedStateKey) {
                range.max = String(Math.max(0, sequence.count - 1))
                range.disabled = sequence.count < 2
                range.setAttribute('aria-label', `${selector.options[selector.selectedIndex]?.text || 'Animation'} step`)
                renderLabels(sequence, index)
                renderedStateKey = stateKey
            }
            error.hidden = true
            range.value = String(index)
            writeValue(index)
        },
        setFrame(index) {
            if (!currentState?.sequence) return
            const next = Math.max(0, Math.min(currentState.sequence.count - 1, index))
            range.value = String(next)
            writeValue(next)
        },
    }
}
