// Decode dictionary H3 words directly into their final numeric buffer.
export function arrowColumnValues(column, name) {
    if ((name === 'index_lower' || name === 'index_upper')
        && column.type.dictionary?.ArrayType === Uint32Array && column.nullCount === 0) {
        const values = new Uint32Array(column.length)
        let offset = 0
        for (const chunk of column.data) {
            const dictionary = chunk.dictionary
            const lookup = dictionary.nullCount === 0 ? dictionary.toArray() : null
            for (let i = 0; i < chunk.length; i++) {
                values[offset++] = lookup ? lookup[chunk.values[i]] : dictionary.get(chunk.values[i])
            }
        }
        return values
    }
    return column.toArray()
}
