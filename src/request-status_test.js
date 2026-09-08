import {createRequestStatus} from './request-status.js'

function assert(condition) { if (!condition) throw new Error('Assertion failed') }
const pause = () => new Promise(resolve => setTimeout(resolve, 15))
function setup() {
    const nodes = Object.fromEntries(['.request-spinner', '.request-error', '.request-error-message', '.request-retry', 'details', 'pre'].map(key => [key, {
        hidden: false, textContent: '', addEventListener(_event, callback) { this.click = callback },
    }]))
    const root = {hidden: false, dataset: {}, querySelector: key => nodes[key]}
    return {root, nodes, status: createRequestStatus(root, {delay: 5})}
}

Deno.test('quick requests do not flash loading feedback', async () => {
    const {root, status} = setup()
    status.begin()
    assert(root.hidden)
    status.clear()
    await pause()
    assert(root.hidden && root.dataset.state === 'idle')
})

Deno.test('failure preserves actionable status and retry until success', async () => {
    const {root, nodes, status} = setup()
    let retries = 0
    status.begin()
    status.fail(new Error('<unsafe>'), {hasResult: true, onRetry: () => { retries++; status.begin() }})
    await pause()
    assert(!root.hidden && nodes['.request-spinner'].hidden)
    assert(nodes['.request-error-message'].textContent.includes('Previous result shown'))
    assert(nodes.pre.textContent === '<unsafe>')
    nodes['.request-retry'].click()
    assert(retries === 1 && nodes['.request-retry'].disabled)
    assert(!nodes['.request-error'].hidden)
    status.clear()
    await pause()
    assert(root.hidden && nodes.pre.textContent === '')
})
