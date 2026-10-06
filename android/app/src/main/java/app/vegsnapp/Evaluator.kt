package app.vegsnapp

import org.json.JSONArray
import org.json.JSONObject
import java.text.Normalizer
import java.time.Instant
import java.util.Locale
import java.util.UUID

data class CheckInput(val text: String = "", val category: String = "other", val complete: Boolean? = null,
    val name: String = "", val barcode: String = "", val locale: String = "en", val truncated: Boolean = false)

internal val compositionHeading = Regex("(?:^|\\n)\\s*(?:ingredients|ingredienser|zutaten|materials|material|zusammensetzung|composition)\\s*:\\s*", RegexOption.IGNORE_CASE)
internal val compositionPrecaution = Regex("\\b(?:may contain|kan innehålla spår av|kann spuren von|kann\\b[^.!]*\\benthalten|spuren von)\\b", RegexOption.IGNORE_CASE)
private const val additiveRoles = "(?:säuerungsmittel|säureregulator(?:en)?|farbstoff(?:e)?|emulgator(?:en)?|verdickungsmittel|stabilisator(?:en)?|konservierungsstoff(?:e)?|antioxidationsmittel|backtriebmittel|geliermittel|überzugsmittel|süßungsmittel|süssungsmittel|acidity regulators?|acidifiers?|colou?r(?:ing)?s?|emulsifiers?|thickeners?|stabilisers?|stabilizers?|preservatives?|antioxidants?|raising agents?|gelling agents?|glazing agents?|sweeteners?|surhetsreglerande medel|syror|färgämnen?|förtjockningsmedel|stabiliseringsmedel|emulgeringsmedel|konserveringsmedel|antioxidationsmedel|bakpulver|jäsmedel|sötningsmedel|geleringsmedel)"
private val additivePrefix = Regex("^\\s*$additiveRoles(?:\\s*:\\s*|\\s+)(?=\\S)", RegexOption.IGNORE_CASE)
private val additiveGroup = Regex("\\b$additiveRoles\\s*:?\\s*(?=\\(\\s*[\\p{L}\\p{N}])", RegexOption.IGNORE_CASE)
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

class Evaluator(private val rulesDocument: JSONObject) {
    private val rules = rulesDocument.getJSONArray("rules")
    private fun ruleForTerm(term: String): JSONObject? = (0 until rules.length()).map { rules.getJSONObject(it) }.firstOrNull { rule ->
        val aliases = rule.getJSONArray("aliases")
        (0 until aliases.length()).any { normalizeCompositionTerm(aliases.getString(it)) == term }
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
            normalizeCompositionTerm(composition) == normalizeCompositionTerm(input.name) && ruleForTerm(normalizeCompositionTerm(composition)) == null
        val fallback = if (validGtin(composition.trim()) || identityOnly) emptyList() else compositionTerms(composition, input.category in setOf("shoes", "clothing")).distinct()
        val parsed = parsedIngredients?.let { parseSourceIngredients(input.text, JSONArray(it)) }
        // AI supplies the split; omissions and misleading compound assessments cannot erase known origins.
        val guards = fallback.flatMap { term -> listOf(term) + if (':' in term) listOf(normalizeCompositionTerm(term.substringAfterLast(':'))) else emptyList() }
            .filter { ruleForTerm(it)?.optString("status") in setOf("animal", "ambiguous") }
        val tokens = if (parsed != null) (parsed + guards).distinct() else fallback
        val findings = JSONArray()
        for (term in tokens) {
            val rule = ruleForTerm(term)
            findings.put(JSONObject().put("term", term).put("status", rule?.getString("status") ?: "unknown")
                .put("ruleId", rule?.getString("id"))
                .put("explanation", rule?.getJSONObject("explanation")?.optString(input.locale)
                    ?: if (input.locale == "de") "Herkunft nicht durch die lokalen Regeln geklärt." else "Origin is not established by the bundled rules.")
                .put("evidenceId", "input"))
        }
        val statuses = (0 until findings.length()).map { findings.getJSONObject(it).getString("status") }
        val complete = input.complete ?: heading.containsMatchIn(input.text)
        val outcome = when {
            "animal" in statuses -> "not_vegan"
            complete && statuses.isNotEmpty() && statuses.all { it == "plant" } && input.category in setOf("food", "drink", "cosmetics", "household") && !needsProcessingEvidence(input) -> "vegan"
            else -> "uncertain"
        }
        val de = input.locale == "de"
        val summary = when (outcome) {
            "not_vegan" -> if (de) "Die vorliegende Liste enthält tierische Zutaten oder Materialien." else "The supplied list contains animal-derived ingredients or materials."
            "vegan" -> if (de) "Die vorliegende Liste erscheint vegan. Herstellung und nicht genannte Hilfsstoffe sind nicht bestätigt." else "The supplied composition appears vegan. Production and undisclosed processing aids are not verified."
            else -> if (de) "Die vorhandenen Belege reichen für eine sichere Aussage nicht aus." else "The available evidence is insufficient for a reliable conclusion."
        }
        val questions = JSONArray()
        if (outcome == "uncertain") {
            val unresolved = (0 until findings.length()).map { findings.getJSONObject(it) }
                .filter { it.getString("status") in setOf("unknown", "ambiguous") }.map { it.getString("term") }
            questions.put(when {
                input.category in setOf("shoes", "clothing") || needsProcessingEvidence(input) -> if (de)
                    "Gibt es eine produktspezifische Vegan-Erklärung des Herstellers (einschließlich Hilfsstoffen, Klebstoffen und Beschichtungen)?"
                    else "Is there a product-specific manufacturer vegan declaration covering processing aids, adhesives, and finishes?"
                !complete || findings.length() == 0 -> if (de) "Zeige die vollständige Zutaten- oder Materialliste." else "Show the complete ingredients or materials label."
                unresolved.isNotEmpty() -> (if (de) "Die Herkunft dieser Zutaten klären: " else "Confirm the origin of: ") + unresolved.joinToString(", ") + "."
                else -> if (de) "Die Produktkategorie bestimmen, um Zutaten und Herstellungsverfahren zu bewerten."
                    else "Identify the product category to assess its ingredients and production requirements."
            })
        }
        return JSONObject().put("schemaVersion", 1).put("id", UUID.randomUUID().toString()).put("outcome", outcome)
            .put("basis", if (outcome == "uncertain") "insufficient" else "composition")
            .put("title", input.name.ifBlank { input.text.take(80).ifBlank { if (de) "Produktprüfung" else "Product check" } })
            .put("summary", summary).put("category", input.category)
            .put("identity", JSONObject().put("name", input.name).put("barcode", input.barcode).put("market", "DE").put("match", "unconfirmed"))
            .put("findings", findings).put("evidence", JSONArray().put(JSONObject().put("id", "input").put("kind", "user_text")
                .put("title", if (de) "Übermittelter Text" else "Supplied text").put("excerpt", input.text).put("retrievedAt", now)))
            .put("questions", questions).put("warnings", JSONArray().apply {
                if (parsedIngredients != null && parsed == null && input.text.isNotBlank()) put(if (de) "Die KI-Zutatenliste stimmt nicht mit der Originalzusammensetzung überein; die lokale Aufteilung wurde verwendet."
                    else "The AI ingredient list could not be matched to the original composition; local splitting was used.")
            }).put("crossContact", crossContact)
            .put("companyConcerns", JSONArray()).put("checkedAt", now).put("usedAI", false)
    }
}

fun validGtin(value: String): Boolean {
    if (value.length !in setOf(8, 12, 13, 14) || value.any { !it.isDigit() || it !in '0'..'9' }) return false
    val sum = value.dropLast(1).reversed().mapIndexed { index, c -> c.digitToInt() * if (index % 2 == 0) 3 else 1 }.sum()
    return (10 - sum % 10) % 10 == value.last().digitToInt()
}
