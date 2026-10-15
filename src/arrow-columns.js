// Use Arrow's public conversion API; do not decode per-batch dictionaries here.
export function arrowColumnValues(column, name) {
    const values = column.toArray()
    return (name === 'index_lower' || name === 'index_upper') && Array.isArray(values)
        && column.type.dictionary?.ArrayType === Uint32Array && column.nullCount === 0
        ? Uint32Array.from(values) : values
}
