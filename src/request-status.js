export function createRequestStatus(root, {delay = 200} = {}) {
    const spinner = root.querySelector('.request-spinner')
    const errorBox = root.querySelector('.request-error')
    const message = root.querySelector('.request-error-message')
    const retryButton = root.querySelector('.request-retry')
    const details = root.querySelector('details')
    const detailText = root.querySelector('pre')
    let timer = null
    let busy = false
    let retry = null

    function clear() {
        clearTimeout(timer)
        timer = null
        busy = false
        retry = null
        root.hidden = true
        root.dataset.state = 'idle'
        spinner.hidden = true
        errorBox.hidden = true
        details.open = false
        detailText.textContent = ''
    }

    retryButton.addEventListener('click', () => retry?.())
    clear()
    return {
        begin() {
            if (busy) return
            busy = true
            root.dataset.state = 'loading'
            retryButton.disabled = true
            timer = setTimeout(() => {
                root.hidden = false
                spinner.hidden = false
            }, delay)
        },
        fail(error, {hasResult = false, onRetry} = {}) {
            clearTimeout(timer)
            timer = null
            busy = false
            retry = onRetry
            root.hidden = false
            root.dataset.state = 'error'
            spinner.hidden = true
            errorBox.hidden = false
            message.textContent = hasResult ? 'Update failed. Previous result shown.' : 'Could not load data.'
            retryButton.disabled = !retry
            detailText.textContent = error?.message || String(error)
        },
        clear,
    }
}
