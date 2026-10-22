package app.vegsnap

import org.json.JSONArray
import org.json.JSONObject
import java.text.Normalizer
import java.time.Instant
import java.util.Locale
import java.util.UUID

data class CheckInput(val text: String = "", val category: String = "other", val complete: Boolean? = null,
    val name: String = "", val barcode: String = "", val locale: String = "en", val truncated: Boolean = false,
    val market: String = "DE", val autoMarket: Boolean? = null)

internal val compositionHeading = Regex("(?:^|\\n)\\s*(?:ingredients|ingredienser|zutaten|materials|material|zusammensetzung|composition)\\s*:\\s*", RegexOption.IGNORE_CASE)
internal val compositionPrecaution = Regex("\\b(?:may contain|kan innehålla spår av|kann spuren von|kann\\b[^.!]*\\benthalten|spuren von)\\b", RegexOption.IGNORE_CASE)
private const val ADDITIVE_ROLES = "(?:säuerungsmittel|säureregulator(?:en)?|farbstoff(?:e)?|emulgator(?:en)?|verdickungsmittel|stabilisator(?:en)?|konservierungsstoff(?:e)?|antioxidationsmittel|backtriebmittel|geliermittel|überzugsmittel|süßungsmittel|süssungsmittel|acidity regulators?|acidifiers?|colou?r(?:ing)?s?|emulsifiers?|thickeners?|stabilisers?|stabilizers?|preservatives?|antioxidants?|raising agents?|gelling agents?|glazing agents?|sweeteners?|surhetsreglerande medel|syror|färgämnen?|förtjockningsmedel|stabiliseringsmedel|emulgeringsmedel|konserveringsmedel|antioxidationsmedel|bakpulver|jäsmedel|sötningsmedel|geleringsmedel|gelatineringsmedel)"
private val additivePrefix = Regex("^\\s*$ADDITIVE_ROLES(?:\\s*:\\s*|\\s+)(?=\\S)", RegexOption.IGNORE_CASE)
private val additiveGroup = Regex("\\b$ADDITIVE_ROLES\\s*:?\\s*(?=\\(\\s*[\\p{L}\\p{N}])", RegexOption.IGNORE_CASE)
private const val materialRoles = "(?:upper(?: material)?|lining|inner material|insole|outsole|sole|oberstoff|obermaterial|außenmaterial|aussenmaterial|innenmaterial|innensohle|decksohle|laufsohle|futter|sohle|ovandel|foder|innersula|yttersula)"
private val materialPrefix = Regex("^\\s*$materialRoles\\s*:\\s*", RegexOption.IGNORE_CASE)
private val materialSection = Regex("(?:^|\\n)\\s*$materialRoles\\s*:", RegexOption.IGNORE_CASE)
internal fun normalizeCompositionTerm(text: String): String = Normalizer.normalize(text, Normalizer.Form.NFKC).lowercase(Locale.ROOT)
    .replace(Regex("[_*]"), "").replace(Regex("\\d+(?:[.,]\\d+)?\\s*%"), "")
    .replace(Regex("\\b(?:organic|bio)\\b"), "")
    .replace(materialPrefix, "")
    .replace(additivePrefix, "").replace(Regex("^\\s*(?:gemüse|vegetables|grönsaker)\\s*[-–:]\\s*(?=\\S)"), "")
    .replace(Regex("\\s+"), " ").trim().trimEnd('.', '!').trim()
internal fun compositionTerms(text: String, materialContext: Boolean = false): List<String> {
    var value = text.lines().filterNot { Regex("^\\s*[*†]\\s*(?:Allergioita tai intoleransseja aiheuttavat aineet korostettu|Ämnen som kan orsaka allergier eller intoleranser (?:är|har) markerade)\\.?\\s*$", RegexOption.IGNORE_CASE).matches(it) }.joinToString("\n")
    val groups = Regex("\\b(?:vitamins?|vitamine|vitaminer|vitamiinit)\\s*\\(", RegexOption.IGNORE_CASE).findAll(value).toList()
    for (group in groups.asReversed()) {
        val start = group.range.last + 1
        var end = start
        var depth = 1
        while (end < value.length && depth > 0) { if (value[end] == '(') depth++; if (value[end] == ')') depth--; end++ }
        if (depth > 0) continue
        val content = value.substring(start, end - 1)
        val expanded = Regex("\\b(?:[ADEK]|B\\d{1,2}|D[23])\\b", RegexOption.IGNORE_CASE).replace(content) { term ->
            if (Regex("vitamin\\s+$", RegexOption.IGNORE_CASE).containsMatchIn(content.take(term.range.first))) term.value else "vitamin ${term.value}"
        }
        value = value.take(group.range.first) + "(" + expanded + ")" + value.substring(end)
    }
    if (materialContext || materialSection.containsMatchIn(text)) value = value.replace("/", ",")
    return value.replace(Regex("\\d+(?:[.,]\\d+)?\\s*%"), "")
        .replace(Regex("\\(\\s*(?:teilentölt|entölt|partially defatted|defatted|partially deoiled|deoiled|delvis avfettat)\\s*\\)", RegexOption.IGNORE_CASE), "")
        .replace(additiveGroup, "")
        .split(Regex("[,;()\\n\\[\\]{}]")).map(::normalizeCompositionTerm).filter { it.isNotEmpty() }
}
internal fun needsProcessingEvidence(input: CheckInput): Boolean = input.category == "drink" &&
    Regex("(?:^|[^\\p{L}\\p{N}])(?:wine|wein|vin|viini|beer|bier|olut|ale|lager|cider|sidra|champagne|sekt|prosecco|alcohol|alkohol|ethanol)(?=$|[^\\p{L}\\p{N}])", RegexOption.IGNORE_CASE).containsMatchIn("${input.name} ${input.text}") || input.category == "drink" &&
    // Swedish beer names remain protected without treating German oil ingredients as beer.
    Regex("(?:^|[^\\p{L}\\p{N}])öl(?=$|[^\\p{L}\\p{N}])", RegexOption.IGNORE_CASE).containsMatchIn(input.name)

private val wordCharacter = Regex("[\\p{L}\\p{N}]")
internal fun containsWord(text: String, word: String): Boolean {
    var start = text.indexOf(word)
    while (start >= 0) {
        val before = text.getOrNull(start - 1)?.toString().orEmpty()
        val after = text.getOrNull(start + word.length)?.toString().orEmpty()
        if (!wordCharacter.containsMatchIn(before) && !wordCharacter.containsMatchIn(after)) return true
        start = text.indexOf(word, start + 1)
    }
    return false
}
// A negation covers the ingredient it introduces: the words up to the first plant or ambiguous ingredient ("no added sugar milk chocolate" keeps milk)
// or the hyphenated word ("non-GMO whole milk"), and a conjunction carries it on ("without milk and eggs", "no milk or eggs").
// Only EN/DE/SV negations: the Finnish "ei" is the German egg ("Ei und Milch").
private const val NEGATIONS = "no|non|not|without|ohne|kein\\w*|utan|ingen|inget|inga|inte|ej|sans|sin|senza|traces?|spuren|spår|free (?:from|of)|frei von|fri från"
// A free-from suffix ("milk-free", "laktosefrei", "glutenfreie", "mjölkfritt", "fleischlos").
private const val FREE_FROM = "free|frei(?:e[rsmn]?)?|fri(?:tt|a)?|los(?:e[rsmn]?)?"
// A substitute, flavour or culture word only covers its own phrase ("natural flavouring and milk powder" contains milk powder).
private const val MODIFIERS = "vegan\\w*|plant|plant-based|pflanzlich\\w*|växtbaserad\\w*|vegetabilisk\\w*|faux|fake|artificial|künstlich\\w*|synthetic\\w*|synthetisch\\w*|kunst\\w*|konst\\w*|syntet\\w*|imitation\\w*|imitiert\\w*|imitat|ersatz|alternative|alternativ|ersättning|substitute|replacer|flavou?r\\w*|aroma\\w*|ar[oô]m\\w*|geschmack\\w*|smak\\w*|cultures?|kultur\\w*"
private val modifiedBefore = Regex("(?:^|[^\\p{L}])(?:$MODIFIERS)(?:$|[^\\p{L}])")
// A free-from suffix covers the word it is attached to, a head noun of the claim and a conjunction list before it ("milk-free", "milk protein-free", "milk and egg free", "milch- und eifrei"), not "milk from free range cows".
private val freeSuffix = Regex("(?:$FREE_FROM)(?=$|[^\\p{L}])")
private val lastWord = Regex("\\p{L}+(?=[^\\p{L}]*$)")
private val modifiedAfter = Regex("(?:$MODIFIERS)(?:$|[^\\p{L}])")
private val wordOrJoiner = Regex("[\\p{L}\\p{N}]+|[&/]")
private fun words(value: String): List<String> = wordOrJoiner.findAll(value).map { it.value }.toList()
/** A stem is a compound component when the letters attached to it could be words themselves: none or at least three before ("Kuhmilch"), none or at least four after ("Milchpulver"). Inflections such as "milchig", "wollen", "silken", "gräddes" or "Flachs" never count, and a stem shorter than four letters ("ägg") must start its word. */
internal fun component(prefix: Int, stem: String, suffix: Int): Boolean {
    val modifier = prefix == 0 || prefix >= 3 && stem.length >= 4
    return modifier && (suffix == 0 || suffix >= 4)
}

class Evaluator(private val rulesDocument: JSONObject) {
    private val rules = rulesDocument.getJSONArray("rules")
    private val aliasRules: Map<String, JSONObject> = LinkedHashMap<String, JSONObject>().apply {
        for (index in 0 until rules.length()) {
            val rule = rules.getJSONObject(index)
            val aliases = rule.getJSONArray("aliases")
            for (alias in 0 until aliases.length()) put(normalizeCompositionTerm(aliases.getString(alias)), rule)
        }
    }
    private val extendedMatching = rulesDocument.getJSONObject("extendedMatching")
    private fun extendedTerms(key: String): List<String> = extendedMatching.getJSONArray(key).let { items -> (0 until items.length()).map { normalizeCompositionTerm(items.getString(it)) } }
    private val compoundStems = extendedTerms("compoundStems").sortedByDescending { it.length }
    private val plantExceptions = extendedTerms("plantExceptions").sortedByDescending { it.length }
    // A with-word starts a new phrase ("plant oil with milk", "milk powder with natural flavouring"); a conjunction also ends a modifier's phrase ("plant oil or milk", "arôme et viande"), and so does a slash
    // ("natural flavouring / milk powder") unless a hyphen shares one head across it ("Huhn-/Pouletgeschmack", "mjölk-/mælkepulver"). Both word lists are data shared with the TypeScript core and match whole words only, so "y", "o" and "e" never match inside a word or an E-number.
    private val withWords = extendedTerms("withWords").joinToString("|")
    private val conjunctions = extendedTerms("conjunctions").joinToString("|")
    private val phrase = Regex("(?:^|[^\\p{L}\\p{N}])(?:$withWords)(?=$|[^\\p{L}\\p{N}])")
    private val conjunct = Regex("(?:^|[^\\p{L}\\p{N}])(?:$withWords|$conjunctions|&)(?=$|[^\\p{L}\\p{N}])|(?<![-–])/")
    private val conjunction = Regex("$conjunctions|&|/")
    private val freeFromHeads = extendedTerms("freeFromHeads").toSet()
    // A negation fused with an animal qualifier ("non-dairy milk", "animal-free collagen", "tierfreies Kollagen", "fleischlose Wurst") keeps covering the following ingredient.
    private val animalQualifiers = extendedTerms("animalQualifiers").joinToString("|")
    private val negations = "(?:non|nicht|icke)[-–]?(?:$animalQualifiers)\\p{L}{0,2}|(?:$animalQualifiers)[-–]?\\s?(?:$FREE_FROM)|$NEGATIONS"
    private val negatedBefore = Regex("(?:^|[^\\p{L}])(?:$negations)(?:$|[^\\p{L}])")
    private val negationWord = Regex("(?:^|[^\\p{L}])(?:$negations)(?=$|[^\\p{L}])")
    /** An alias that reads as a negation or modifier itself ("pflanzlich gegerbtes Leder") or doubles as a word of another language ("ei": Finnish "not", Romanian "they") only matches exactly; inside longer text it is as likely an OCR fragment as an egg. */
    private val exactOnlyAliases = extendedTerms("exactOnlyAliases").toSet()
    private fun readsAsModifier(alias: String): Boolean = alias in exactOnlyAliases || negatedBefore.containsMatchIn(alias) || modifiedBefore.containsMatchIn(alias)
    private val animalAliases = aliasRules.filterValues { it.getString("status") == "animal" }.keys.filterNot(::readsAsModifier).sortedByDescending { it.length }
    /** Hosts allowed to settle a web claim as certification evidence (shared with the TypeScript core). */
    internal val veganCertifiers: Set<String> = rulesDocument.optJSONArray("veganCertifiers")?.let { items -> (0 until items.length()).map { items.getString(it) }.toSet() }.orEmpty()
    /** The last negation before the mention still covers it unless a plant or ambiguous ingredient (or the hyphenated word) closed its scope without a conjunction reopening it. */
    private fun negated(before: String): Boolean {
        val last = negationWord.findAll(before).lastOrNull() ?: return false
        val rest = before.substring(last.range.last + 1)
        var open = true
        var bound = rest.startsWith("-") || rest.startsWith("–")
        for (word in words(rest)) {
            if (conjunction.matches(word)) { open = true; continue }
            if (open && (bound || aliasRules[word]?.getString("status") in setOf("plant", "ambiguous"))) open = false
            bound = false
        }
        return open
    }
    /** A free-from suffix covers the mention inside the same word ("Milcheiweißfrei"), behind a head noun of the claim ("milk protein-free", "dairy ingredient-free") or across conjunction-led words only; a separate word glued to the suffix must itself be an ingredient ("eifrei", not "cellulose"). */
    private fun freed(after: String): Boolean {
        val match = freeSuffix.find(after) ?: return false
        var between = after.take(match.range.first)
        val head = lastWord.find(between)
        if (head != null && head.value in freeFromHeads) between = between.take(head.range.first)
        if (between.all { it.isLetter() }) return true
        val list = words(between)
        for (index in list.indices step 2) if (!conjunction.matches(list[index]) || index + 1 >= list.size || conjunction.matches(list[index + 1])) return false
        return !between.last().isLetter() || aliasRules.containsKey(list.last())
    }
    /** The item occurs (as a whole word, or as a compound stem forming a component) without a negation or modifier covering that occurrence. */
    private fun mentioned(text: String, item: String, wholeWord: Boolean): Boolean {
        var start = text.indexOf(item)
        while (start >= 0) {
            val end = start + item.length
            val before = text.substring(0, start)
            val after = text.substring(end)
            val boundary = if (wholeWord) !wordCharacter.containsMatchIn(text.getOrNull(start - 1)?.toString().orEmpty()) && !wordCharacter.containsMatchIn(text.getOrNull(end)?.toString().orEmpty())
                else component(before.takeLastWhile { it.isLetter() }.length, item, after.takeWhile { it.isLetter() }.length)
            val blockedBefore = negated(before.split(phrase).last()) || modifiedBefore.containsMatchIn(before.split(conjunct).last())
            val blockedAfter = freed(after.split(phrase).first()) || modifiedAfter.containsMatchIn(after.split(conjunct).first())
            if (boundary && !blockedBefore && !blockedAfter) return true
            start = text.indexOf(item, start + 1)
        }
        return false
    }
    /** A whole-word occurrence of the alias starts before the span and reaches into it ("Griskött" over "skött"), or starts with the span and outgrows it ("Fischgräten" over "Fischgrät"). */
    private fun overlaps(value: String, alias: String, start: Int, end: Int): Boolean {
        var at = value.indexOf(alias)
        while (at in 0..start) {
            val whole = !wordCharacter.containsMatchIn(value.getOrNull(at - 1)?.toString().orEmpty()) && !wordCharacter.containsMatchIn(value.getOrNull(at + alias.length)?.toString().orEmpty())
            if (whole && at + alias.length > (if (at < start) start else end)) return true
            at = value.indexOf(alias, at + 1)
        }
        return false
    }
    /** A plant exception is removed where it starts a word ("oat milk powder", not "goat milk powder") or follows a compound modifier of at least three letters ("walnut butter", "Tomatfruktkött"), unless an animal alias overlaps it; an inflection or compound tail after it keeps its plant head ("beef tomatoes", "king oysters", "Hafermilchkonzentrat"). */
    private fun withoutPlantExceptions(term: String): String {
        var value = term
        for (exception in plantExceptions) {
            var start = value.indexOf(exception)
            while (start >= 0) {
                val end = start + exception.length
                val prefix = value.take(start).takeLastWhile { it.isLetter() }.length
                if (component(prefix, exception, 0) && animalAliases.none { overlaps(value, it, start, end) }) value = value.take(start) + " " + value.substring(end)
                start = value.indexOf(exception, start + 1)
            }
        }
        return value
    }
    /** An exact alias wins; otherwise an unmodified animal alias as a whole word, or a compound stem, inside the term identifies the rule. */
    private fun ruleForTerm(term: String): JSONObject? {
        aliasRules[term]?.let { return it }
        val remainder = withoutPlantExceptions(term)
        val alias = animalAliases.firstOrNull { mentioned(remainder, it, true) } ?: compoundStems.firstOrNull { mentioned(remainder, it, false) }
        return alias?.let { aliasRules[it] }
    }
    fun evaluate(input: CheckInput, parsedIngredients: List<String>? = null): JSONObject {
        val now = Instant.now().toString()
        val heading = compositionHeading
        val headingMatch = heading.find(input.text)
        val materialMatch = if (headingMatch == null && input.category in setOf("shoes", "clothing", "other")) materialSection.find(input.text) else null
        val body = when {
            headingMatch != null -> input.text.substring(headingMatch.range.last + 1)
            materialMatch != null -> input.text.substring(materialMatch.range.first).trim()
            else -> input.text
        }
        val precaution = compositionPrecaution.find(body)
        val composition = if (precaution == null) body else body.take(precaution.range.first)
        val crossContact = JSONArray().apply { precaution?.let { put(body.substring(it.range.first).trim()) } }
        // A barcode identifies a product; it is not a composition term.
        val identityOnly = headingMatch == null && input.complete != true && input.name.isNotBlank() &&
            normalizeCompositionTerm(composition) == normalizeCompositionTerm(input.name) && aliasRules[normalizeCompositionTerm(composition)] == null
        val fallback = if (validGtin(composition.trim()) || identityOnly) emptyList() else compositionTerms(composition, input.category in setOf("shoes", "clothing")).distinct()
        val parsed = parsedIngredients?.let { parseSourceIngredients(input.text, JSONArray(it)) }
        // AI supplies the split; omissions and misleading compound assessments cannot erase known origins.
        val status = { term: String -> ruleForTerm(term)?.optString("status") }
        // The ingredient after a role prefix is the guard, but an animal whole term outranks a plant or ambiguous suffix ("Milchschokolade: Zucker", "Milchschokolade: E471").
        val guards = fallback.mapNotNull { term ->
            val candidates = if (':' in term) listOf(normalizeCompositionTerm(term.substringAfterLast(':')), term) else listOf(term)
            candidates.firstOrNull { status(it) == "animal" } ?: candidates.firstOrNull { status(it) == "ambiguous" }
        }
        val tokens = if (parsed != null) (parsed + guards).distinct() else fallback
        val findings = JSONArray()
        for (term in tokens) {
            val rule = ruleForTerm(term)
            findings.put(JSONObject().put("term", term).put("status", rule?.getString("status") ?: "unknown")
                .put("ruleId", rule?.getString("id"))
                .put("explanation", rule?.getJSONObject("explanation")?.let { it.optString(input.locale).ifBlank { it.getString("en") } }
                    ?: ResultStrings.unknownOrigin(input.locale))
                .put("evidenceId", "input"))
        }
        val statuses = (0 until findings.length()).map { findings.getJSONObject(it).getString("status") }
        val complete = input.complete ?: heading.containsMatchIn(input.text)
        val outcome = when {
            "animal" in statuses -> "not_vegan"
            complete && statuses.isNotEmpty() && statuses.all { it == "plant" } && input.category in setOf("food", "drink", "cosmetics", "household") && !needsProcessingEvidence(input) -> "vegan"
            else -> "uncertain"
        }
        val summary = when (outcome) {
            "not_vegan" -> ResultStrings.animalCompositionSummary(input.locale)
            "vegan" -> ResultStrings.veganCompositionSummary(input.locale)
            else -> ResultStrings.uncertainCompositionSummary(input.locale)
        }
        val questions = JSONArray()
        if (outcome == "uncertain") {
            val unresolved = (0 until findings.length()).map { findings.getJSONObject(it) }
                .filter { it.getString("status") in setOf("unknown", "ambiguous") }.map { it.getString("term") }
            questions.put(when {
                input.category in setOf("shoes", "clothing") || needsProcessingEvidence(input) -> ResultStrings.manufacturerDeclarationQuestion(input.locale)
                !complete || findings.length() == 0 -> ResultStrings.completeLabelQuestion(input.locale)
                unresolved.isNotEmpty() -> (ResultStrings.originQuestionPrefix(input.locale)) + unresolved.joinToString(", ") + "."
                else -> ResultStrings.categoryQuestion(input.locale)
            })
        }
        return JSONObject().put("schemaVersion", 1).put("id", UUID.randomUUID().toString()).put("outcome", outcome)
            .put("basis", if (outcome == "uncertain") "insufficient" else "composition")
            .put("title", input.name.ifBlank { input.text.take(80).ifBlank { ResultStrings.productCheck(input.locale) } })
            .put("summary", summary).put("category", input.category)
            .put("identity", JSONObject().put("name", input.name).put("barcode", input.barcode).put("market", input.market).put("match", "unconfirmed"))
            .put("findings", findings).put("evidence", JSONArray().put(JSONObject().put("id", "input").put("kind", "user_text")
                .put("title", ResultStrings.suppliedText(input.locale)).put("excerpt", input.text).put("retrievedAt", now)))
            .put("questions", questions).put("warnings", JSONArray().apply {
                if (parsedIngredients != null && parsed == null && input.text.isNotBlank()) put(ResultStrings.aiIngredientsMismatch(input.locale))
            }).put("crossContact", crossContact)
            .put("companyConcerns", JSONArray()).put("checkedAt", now).put("usedAI", false)
    }
}

fun validGtin(value: String): Boolean {
    if (value.length !in setOf(8, 12, 13, 14) || value.any { !it.isDigit() || it !in '0'..'9' }) return false
    val sum = value.dropLast(1).reversed().mapIndexed { index, c -> c.digitToInt() * if (index % 2 == 0) 3 else 1 }.sum()
    return (10 - sum % 10) % 10 == value.last().digitToInt()
}
