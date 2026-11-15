package app.vegsnap

internal val labelledSection = Regex("^\\s*\\p{L}[\\p{L} '-]{0,40}:")
internal data class PrecautionSplit(val ingredients: String, val crossContact: List<String>, val tail: String)
/**
 * A precaution ends at its closing bracket or at the end of its sentence. A bracketed one resumes the list
 * ("oil (may contain palm oil), whey"); after a sentence, the tail is only checked for exact animal terms.
 */
internal fun splitPrecaution(body: String): PrecautionSplit {
    val ingredients = StringBuilder()
    val tail = StringBuilder()
    val crossContact = mutableListOf<String>()
    var offset = 0
    var afterSentence = false
    // Search the remaining text, as the TypeScript core does, and keep positions absolute.
    fun next() = compositionPrecaution.find(body.substring(offset))?.let { (it.range.first + offset)..(it.range.last + offset) }
    var match = next()
    while (match != null) {
        val start = match.first
        (if (afterSentence) tail else ingredients).append(body, offset, start)
        val close = closingBracket(body, start)
        val end = close ?: Regex("[.!](?=\\s|$)|\\n").find(body, match.last + 1)?.let { it.range.first + 1 } ?: body.length
        crossContact += body.substring(start, end).trim()
        offset = end
        afterSentence = afterSentence || close == null
        match = next()
    }
    (if (afterSentence) tail else ingredients).append(body, offset, body.length)
    return PrecautionSplit(ingredients.toString(), crossContact, tail.toString())
}
/** The bracket closing the one a precaution at [start] was opened in, if any; depth counts the whole text before it. */
private fun closingBracket(text: String, start: Int): Int? {
    val open = text.take(start).fold(0) { depth, char -> when (char) { '(', '[' -> depth + 1; ')', ']' -> maxOf(0, depth - 1); else -> depth } }
    if (open == 0) return null
    var level = 0
    for (index in start until text.length) {
        when (text[index]) {
            '(', '[' -> level++
            ')', ']' -> if (level == 0) return index else level--
        }
    }
    return null
}
