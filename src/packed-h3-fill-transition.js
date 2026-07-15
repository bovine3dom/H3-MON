import {LayerExtension} from '@deck.gl/core'

const TRANSITION_STATE = Symbol('packedH3FillTransition')
const identity = value => value
const clamp = value => Math.max(0, Math.min(1, value))

function transitionProgress(startedAt, duration, now, easing) {
    const raw = duration > 0 ? clamp((now - startedAt) / duration) : 1
    return {raw, eased: clamp(easing(raw))}
}

function colorAttribute(value) {
    return {value, size: 4, type: 'unorm8', normalized: true}
}

function createTransition(from, to, geometry, startedAt, duration, scratch = null) {
    return {
        from,
        to,
        geometry,
        startedAt,
        duration,
        scratch,
        fromAttribute: colorAttribute(from),
    }
}

export class PackedH3FillTransitionExtension extends LayerExtension {
    static extensionName = 'PackedH3FillTransitionExtension'
    static defaultProps = {
        _packedH3FillStartedAt: 0,
        _packedH3FillDuration: 0,
    }

    constructor({duration = 0, easing = identity} = {}) {
        super({
            duration: Math.max(0, Number(duration) || 0),
            easing: typeof easing === 'function' ? easing : identity,
        })
    }

    getShaders() {
        return {
            inject: {
                'vs:#decl': `
                    in vec4 fillColorsFrom;
                    uniform float packedH3FillProgress;
                    uniform float packedH3FillOpacity;
                `,
                'vs:DECKGL_FILTER_COLOR': `
                    color = mix(
                        vec4(fillColorsFrom.rgb, fillColorsFrom.a * packedH3FillOpacity),
                        color,
                        packedH3FillProgress
                    );
                `,
            },
        }
    }

    initializeState() {
        if (this.isComposite) return
        this.getAttributeManager()?.add({
            fillColorsFrom: {
                size: 4,
                type: 'unorm8',
                stepMode: 'dynamic',
                noAlloc: true,
            },
        })
    }

    updateState(_params, extension) {
        if (!this.isComposite) return

        // faster-h3 builds the target bytes before extension updates run.
        const binaryData = this.state.binaryData
        const targetAttribute = binaryData?.attributes?.fillColors
        const to = targetAttribute?.value
        const geometry = this.state.geometry
        if (!(to instanceof Uint8Array) && !(to instanceof Uint8ClampedArray)) return

        let transition = this.state[TRANSITION_STATE]
        if (!transition) {
            transition = createTransition(to, to, geometry, 0, 0)
        } else if (to !== transition.to) {
            const now = this.context.timeline.getTime()
            const canInterpolate = extension.opts.duration > 0 &&
                geometry === transition.geometry &&
                to.length === transition.to.length
            let from = to
            let duration = 0
            let scratch = null

            if (canInterpolate) {
                const {eased} = transitionProgress(
                    transition.startedAt,
                    transition.duration,
                    now,
                    extension.opts.easing,
                )
                from = transition.to
                if (eased < 1 && transition.from !== transition.to) {
                    // Preserve continuity without mutating either package-owned endpoint.
                    scratch = transition.scratch
                    if (!scratch || scratch.length !== to.length) scratch = new Uint8Array(to.length)
                    for (let i = 0; i < scratch.length; i++) {
                        scratch[i] = Math.round(transition.from[i] + (transition.to[i] - transition.from[i]) * eased)
                    }
                    from = scratch
                }
                duration = extension.opts.duration
            }
            transition = createTransition(from, to, geometry, duration ? now : 0, duration, scratch)
        } else if (geometry !== transition.geometry) {
            transition = createTransition(to, to, geometry, 0, 0)
        }

        this.state[TRANSITION_STATE] = transition
        const fillColors = targetAttribute.normalized === true
            ? targetAttribute
            : {...targetAttribute, normalized: true}
        if (fillColors !== targetAttribute || binaryData.attributes.fillColorsFrom !== transition.fromAttribute) {
            binaryData.attributes = {
                ...binaryData.attributes,
                fillColors,
                fillColorsFrom: transition.fromAttribute,
            }
        }
    }

    getSubLayerProps() {
        const transition = this.state[TRANSITION_STATE]
        return {
            _packedH3FillStartedAt: transition?.startedAt ?? 0,
            _packedH3FillDuration: transition?.duration ?? 0,
        }
    }

    draw({uniforms}, extension) {
        const {raw, eased} = transitionProgress(
            this.props._packedH3FillStartedAt,
            this.props._packedH3FillDuration,
            this.context.timeline.getTime(),
            extension.opts.easing,
        )
        uniforms.packedH3FillProgress = eased
        uniforms.packedH3FillOpacity = uniforms.opacity
        // No attribute changes are needed during animation; only this uniform advances.
        if (raw < 1) this.setNeedsRedraw()
    }
}
