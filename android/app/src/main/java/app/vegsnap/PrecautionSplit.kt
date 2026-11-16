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
    // After a bracketed precaution the list resumes only to the end of its sentence ("salt (may contain nuts). Made in…").
    var listEnd = Int.MAX_VALUE
    fun take(until: Int) {
        if (!afterSentence && until > listEnd) { ingredients.append(body, offset, listEnd); offset = listEnd; afterSentence = true }
        (if (afterSentence) tail else ingredients).append(body, offset, until)
    }
    // Search the remaining text, as the TypeScript core does, and keep positions absolute.
    fun next() = compositionPrecaution.find(body.substring(offset))?.let { (it.range.first + offset)..(it.range.last + offset) }
    var match = next()
    while (match != null) {
        val start = match.first
        take(start)
        val close = closingBracket(body, start)
        val end = close ?: sentenceEnd(body, match.last + 1)
        crossContact += body.substring(start, end).trim()
        offset = end
        // A boundary saved inside this precaution no longer ends the list.
        if (end > listEnd) listEnd = Int.MAX_VALUE
        if (close != null && !afterSentence) listEnd = minOf(listEnd, sentenceEnd(body, end))
        afterSentence = afterSentence || close == null
        match = next()
    }
    take(body.length)
    return PrecautionSplit(ingredients.toString(), crossContact, tail.toString())
}
// A line break after a comma or semicolon wraps the list rather than ending the sentence.
private val sentenceBoundary = Regex("[.!](?=\\s|$)|(?<![,;][^\\S\\n]{0,20})\\n")
/** The position after the sentence that continues at [from], or the end of [text]. */
private fun sentenceEnd(text: String, from: Int): Int = sentenceBoundary.find(text, from)?.let { it.range.first + 1 } ?: text.length
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
