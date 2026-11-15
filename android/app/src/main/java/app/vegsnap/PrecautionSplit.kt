package app.vegsnap

internal data class PrecautionSplit(val ingredients: String, val crossContact: List<String>, val tail: String)
/**
 * A precaution ends at its closing bracket or at the end of its sentence. A bracketed one resumes the list
 * ("oil (may contain palm oil), whey"); after a sentence, the tail is only checked for exact animal terms.
 */
internal fun splitPrecaution(body: String): PrecautionSplit {
    val ingredients = StringBuilder()
    val tail = StringBuilder()
    val crossContact = mutableListOf<String>()
    var rest = body
    var afterSentence = false
    var match = compositionPrecaution.find(rest)
    while (match != null) {
        (if (afterSentence) tail else ingredients).append(rest.take(match.range.first))
        val close = closingBracket(rest, match.range.first)
        val end = close ?: Regex("[.!](?=\\s|$)|\\n").find(rest, match.range.last + 1)?.let { it.range.first + 1 } ?: rest.length
        crossContact += rest.substring(match.range.first, end).trim()
        rest = rest.substring(end)
        afterSentence = afterSentence || close == null
        match = compositionPrecaution.find(rest)
    }
    (if (afterSentence) tail else ingredients).append(rest)
    return PrecautionSplit(ingredients.toString(), crossContact, tail.toString())
}
/** The bracket closing the one a precaution at [start] was opened in, if any. */
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
