/** 固定正文与 Unicode 分段；片段拼接必须能还原正文。 */
export function replyParts(text: string, maxChars = 4500, bubbles = true): { text: string; parts: string[]; part_sizes: number[] } {
  const body = text.replace(/\r\n?/g, '\n').trim()
  const units: string[] = []
  let fence = '', structured = false
  for (const line of body.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? []) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/u)?.[1]
    const isStructured = /^\s*(?:[-*+]\s|\d+[.)]\s|>)|^ {2,}\S/u.test(line) || line.includes('|')
    if (!bubbles || fence || (structured && (isStructured || !line.trim())) || !line.trim()) {
      if (units.length) units[units.length - 1] += line
      else units.push(line)
    } else units.push(line)
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ''
    }
    structured = !fence && isStructured
  }
  if (bubbles && units.length > 6) {
    const merged: string[] = [], size = Math.ceil(units.length / 6)
    for (let index = 0; index < units.length; index += size) merged.push(units.slice(index, index + size).join(''))
    units.splice(0, units.length, ...merged)
  }
  const parts: string[] = []
  for (let unitIndex = 0; unitIndex < units.length; unitIndex++) {
    const points = Array.from(units[unitIndex])
    const limit = maxChars > 0 ? maxChars : points.length
    for (let start = 0; start < points.length;) {
      let end = Math.min(start + limit, points.length)
      if (end < points.length) {
        for (let at = end - 1; at >= start + Math.floor(limit / 2); at--) {
          if (/[\n。！？!?；;，,]/u.test(points[at])) { end = at + 1; break }
        }
      }
      const chunk = points.slice(start, end).join('')
      // 长度边界恰好落在换行前时，把分隔符留给下一段，避免发空白气泡。
      if (!chunk.trim() && unitIndex + 1 < units.length) units[unitIndex + 1] = chunk + units[unitIndex + 1]
      else parts.push(chunk)
      start = end
    }
  }
  return { text: body, parts, part_sizes: parts.map(part => Array.from(part).length) }
}
