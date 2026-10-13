// After navigation and cell metadata are built, keep only the join columns.
export function compactCartogramColumns(columns) {
    if (!columns.index_lower || !columns.index_upper) return null
    const names = ['index_lower', 'index_upper', 'weight', 'weight_mean']
        .filter(name => columns[name] != null)
    if (!names.every(name => ArrayBuffer.isView(columns[name]) && typeof columns[name].slice === 'function')) return null
    const result = {}
    for (const name of names) {
        const column = columns[name]
        // A small view otherwise retains the entire decoded Arrow file.
        result[name] = column.byteOffset || column.byteLength !== column.buffer.byteLength ? column.slice() : column
    }
    if (columns._h3Strings) result._h3Strings = columns._h3Strings
    return result
}
