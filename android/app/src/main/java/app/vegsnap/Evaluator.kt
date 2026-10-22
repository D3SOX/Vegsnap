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

internal val compositionHeading = Regex("(?:^|\\n)\\s*(?:ingredients|ingredienser|zutaten|materials|material|zusammensetzung|composition|ingrédients|ingredientes|ingredienti|ingrediënten|ingredienten|ainesosat|ainekset)\\s*:\\s*", RegexOption.IGNORE_CASE)
internal val compositionPrecaution = Regex("\\b(?:may contain|kan innehålla spår av|kann spuren von|kann\\b(?!\\s+(?:eine?[nrs]?|einer) (?:oder mehrere|der folgenden)(?![^.:;)]*(?:allerg|trace|traza|tracc|spor|spur|spår|jäämi)))[^.!]*\\benthalten|spuren von|peut contenir|traces? (?:éventuelles? )?de|(?:fabriqu[ée]e?s?|produits?) dans une? (?:atelier|usine)|puede contener|trazas de|(?:elaborad|fabricad)[oa]s? en una? (?:fábrica|instalaci[óo]n|planta)|pu[oò] contenere|tracce di|prodott[oa] in uno stabilimento|kan\\b(?!\\s+(?:een|één) of meer(?![^.:;)]*(?:allerg|trace|traza|tracc|spor|spur|spår|jäämi)))[^.!]*\\bbevatten|sporen van|kan inneholde|kan indeholde|spor av|spor af|(?:voi|saattaa) sisältää|jäämiä)(?![\\p{L}\\p{N}])(?!\\s+(?:one or more|either|any (?:one )?of|une? ou plusieurs|l'une? des|uno o (?:más|varios)|alguno de|uno o più|uno dei|een of meer|en eller flere|ett eller flera|én eller flere|yksi tai useampi)(?![\\p{L}\\p{N}])(?![^.:;)]*(?:allerg|trace|traza|tracc|spor|spur|spår|jäämi)))", RegexOption.IGNORE_CASE)
private const val ADDITIVE_ROLES = "(?:säuerungsmittel|säureregulator(?:en)?|farbstoff(?:e)?|emulgator(?:en)?|verdickungsmittel|stabilisator(?:en)?|konservierungsstoff(?:e)?|antioxidationsmittel|backtriebmittel|geliermittel|überzugsmittel|süßungsmittel|süssungsmittel|acidity regulators?|acidifiers?|colou?r(?:ing)?s?|emulsifiers?|thickeners?|stabilisers?|stabilizers?|preservatives?|antioxidants?|raising agents?|gelling agents?|glazing agents?|sweeteners?|surhetsreglerande medel|syror|färgämnen?|förtjockningsmedel|stabiliseringsmedel|emulgeringsmedel|konserveringsmedel|antioxidationsmedel|bakpulver|jäsmedel|sötningsmedel|geleringsmedel|gelatineringsmedel|humectants?|firming agents?|flavou?r enhancers?|bulking agents?|anti-?caking agents?|flour treatment agents?|emulsifying salts?|acidity correctors?|food acids?|acids?(?= *:)|mineral salts?|vegetable gums?|leavening(?: agents?)?|feuchthaltemittel|geschmacksverstärker|trennmittel|mehlbehandlungsmittel|festigungsmittel|füllstoffe?|schmelzsalze?|syra|fuktighetsbevarande medel|smakförstärkare|klumpförebyggande medel|ytbehandlingsmedel|mjölbehandlingsmedel|fyllnadsmedel|acidifiants?|correcteurs? d['’]acidité|[ée]mulsifiants?|[ée]paississants?|stabilisants?|gélifiants?|conservateurs?|antioxydants?|colorants?|édulcorants?|affermissants?|exhausteurs? de go[uû]t|agents? de traitement de la farine|agents? d['’]enrobage|agents? de charge|poudres? à lever|agents? levants?|anti-?agglomérants?|séquestrants?|sels? de fonte|acidulantes?|correctores? de (?:la )?acidez|reguladores? de (?:la )?acidez|emulgentes?|emulsionantes?|espesantes?|estabilizantes?|estabilizadores?|gelificantes?|conservadores?|conservantes?|antioxidantes?|colorantes?|edulcorantes?|potenciadores? del sabor|gasificantes?|impulsores?|agentes? de recubrimiento|humectantes?|antiaglomerantes?|sales fundentes|acidificant[ei]|correttor[ei] di acidità|regolator[ei] di acidità|emulsionant[ei]|addensant[ei]|stabilizzant[ei]|gelificant[ei]|conservant[ei]|antiossidant[ei]|colorant[ei]|edulcorant[ei]|esaltator[ei] di sapidità|agent[ei] lievitant[ei]|agent[ei] di rivestimento|umidificant[ei]|antiagglomerant[ei]|agent[ei] di carica|sali di fusione|zuurteregelaars?|voedingszu(?:ur|ren)|verdikkingsmiddel(?:en)?|geleermiddel(?:en)?|conserveermiddel(?:en)?|antioxidanten|kleurstof(?:fen)?|zoetstof(?:fen)?|smaakversterkers?|rijsmiddel(?:en)?|glansmiddel(?:en)?|bevochtigingsmiddel(?:en)?|antiklontermiddel(?:en)?|meelverbeteraars?|verstevigingsmiddel(?:en)?|emulgatorer|fortykningsmid(?:del|ler)|konserveringsmid(?:del|ler)|surhetsregulerende mid(?:del|ler)|surhedsregulerende mid(?:del|ler)|antioksidant(?:er)?|antioxidanter|fargestoff(?:er)?|farvestof(?:fer)?|stabilisatorer|søtstoff(?:er)?|sødestof(?:fer)?|hevemid(?:del|ler)|hævemid(?:del|ler)|smaksforsterker|smagsforstærker|fuktighetsbevarende middel|fugtighedsbevarende middel|melbehandlingsmiddel|overflatebehandlingsmiddel|overfladebehandlingsmiddel|geleringsmiddel|(?:emulgointi|happamuudensäätö|säilöntä|sakeuttamis|stabilointi|väri|makeutus|kohotus|hapettumisenesto|kostutus|paakkuuntumisenesto|pintakäsittely|hyytelöimis)aine(?:et)?|arominvahven(?:ne|teet)|jauhonparanne|farge|farve|konsistensmid(?:del|ler)|fuktighetsbevarer|antiklump(?:e|nings)mid(?:del|ler)|surheitsregulerande mid(?:del|lar)|surhetsregulator(?:er)?|smeltesalt(?:er)?|melbehandlingsmidler|syrer?(?= *:)|nostatusaine(?:et)?|värit?|kosteudensäilyttäjä|hap(?:po|ot)(?= *:))"
private val additivePrefix = Regex("^\\s*$ADDITIVE_ROLES(?:\\s*:\\s*|\\s+)(?=\\S)", RegexOption.IGNORE_CASE)
// Australian and New Zealand labels give additives as bare INS numbers after their role ("emulsifier (471)", "mineral salts (452, 450)", "food acid: 330"); elsewhere a bare number is a quantity or a nutrition value.
private val insAfterRole = Regex("(?<![\\p{L}\\p{N}])$ADDITIVE_ROLES\\s*(?:\\([^()]*\\)|:[^,;()\\n]*(?:,\\s*\\d{3,4}[a-h]?(?=\\s*(?:[,;()\\n]|\\z)))*)", RegexOption.IGNORE_CASE)
private val insNumber = Regex("(?<![\\p{L}\\p{N}])(?<![eE][\\s-])(\\d{3,4}[a-h]?)(?!\\p{N})")
private val additiveGroup = Regex("(?<![\\p{L}\\p{N}])$ADDITIVE_ROLES\\s*:?\\s*(?=\\(\\s*[\\p{L}\\p{N}])", RegexOption.IGNORE_CASE)
private const val materialRoles = "(?:upper(?: material)?|lining|inner material|insole|outsole|sole|oberstoff|obermaterial|außenmaterial|aussenmaterial|innenmaterial|innensohle|decksohle|laufsohle|futter|sohle|ovandel|foder|innersula|yttersula)"
private val materialPrefix = Regex("^\\s*$materialRoles\\s*:\\s*", RegexOption.IGNORE_CASE)
private val materialSection = Regex("(?:^|\\n)\\s*$materialRoles\\s*:", RegexOption.IGNORE_CASE)
// A list split before its last item leaves the conjunction on it ("sugar, and salt", "and/or sunflower oil").
private val leadingConjunction = Regex("^(?:and/or|und/oder|and|und|och|og|ja|et|ou|y|ed|en|or|oder|eller) (?=\\S)")
internal fun normalizeCompositionTerm(text: String): String = Normalizer.normalize(text, Normalizer.Form.NFKC).lowercase(Locale.ROOT).replace('’', '\'')
    .replace(Regex("[_*\"]"), "").replace(Regex("(?<=\\p{L}{4})\\d{1,2}$"), "").replace(Regex("\\d+(?:[.,]\\d+)?\\s*%"), "")
    .replace(Regex("\\b(?:organic|bio)\\b"), "")
    .replace(materialPrefix, "")
    .replace(additivePrefix, "").replace(Regex("^\\s*(?:gemüse|vegetables|grönsaker)\\s*[-–:]\\s*(?=\\S)"), "")
    .replace(Regex("\\s+"), " ").trim().trimEnd('.', '!').trim().replace(leadingConjunction, "")
internal fun compositionTerms(text: String, materialContext: Boolean = false): List<String> {
    var value = text.replace(Regex("&(?:quot|#34);"), "\"").replace(Regex("&(?:apos|#39);"), "'").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&").lines().filterNot { Regex("^\\s*[*†]\\s*(?:Allergioita tai intoleransseja aiheuttavat aineet korostettu|Ämnen som kan orsaka allergier eller intoleranser (?:är|har) markerade)\\.?\\s*$", RegexOption.IGNORE_CASE).matches(it) }.joinToString("\n")
    val groups = Regex("\\b(?:vitamins?|vitamine[ns]?|vitaminer|vitamiinit|vitaminas|vitamini)\\s*\\(", RegexOption.IGNORE_CASE).findAll(value).toList()
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
        .replace(insAfterRole) { insNumber.replace(it.value, "e$1") }
        .replace(additiveGroup, "")
        .split(Regex("[,;()\\n\\[\\]{}]")).map(::normalizeCompositionTerm).filter { it.isNotEmpty() }
}
internal fun needsProcessingEvidence(input: CheckInput): Boolean = input.category == "drink" &&
    Regex("(?:^|[^\\p{L}\\p{N}])(?:wine|wein|vin|vino|wijn|viini|beer|bier|bière|biere|birra|cerveza|olut|øl|ale|lager|cider|cidre|sidra|sidro|champagne|sekt|prosecco|alcohol|alkohol|ethanol)(?=$|[^\\p{L}\\p{N}])", RegexOption.IGNORE_CASE).containsMatchIn("${input.name} ${input.text}") || input.category == "drink" &&
    // Swedish beer names remain protected without treating German oil ingredients as beer.
    Regex("(?:^|[^\\p{L}\\p{N}])öl(?=$|[^\\p{L}\\p{N}])", RegexOption.IGNORE_CASE).containsMatchIn(input.name)

private val additiveNumber = Regex("e[\\s-]?(\\d{3,4}[a-h]?)(?:\\s?\\(?(?:i{1,3}|iv|v|vi)\\)?)?")
private val wordCharacter = Regex("[\\p{L}\\p{N}]")
// Negation, modifier and free-from scopes on real labels span far less than this, so each mention only looks this far around itself and repeated mentions stay linear.
// The window ends on word boundaries, so a cut word never reads as "no" or "free", and a scope cut off by it can only make a mention count, never hide one.
private const val SCOPE_WINDOW = 300
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
// A bare Finnish "ei" is never a negation: it is the German egg ("Ei und Milch"); only its fixed phrases ("ei sisällä", "ei lisättyä") are.
private const val NEGATIONS = "no|non|not|without|ohne|kein\\w*|utan|ingen|inget|inga|inte|ej|uten|uden|ikke|ilman|ei sisällä|ei lisättyä|sans|sin|senza|traces?|spuren|spår|spor|zonder|geen|free (?:from|of)|frei von|fri från|vrij van|libre de|privo di"
// A free-from suffix ("milk-free", "laktosefrei", "glutenfreie", "mjölkfritt", "fleischlos").
private const val FREE_FROM = "free|frei(?:e[rsmn]?)?|fri(?:tt|a)?|los(?:e[rsmn]?)?|vrije?"
// A negation fused with an animal qualifier ("non-dairy milk", "animal-free collagen", "tierfreies Kollagen", "fleischlose Wurst").
private fun qualified(qualifiers: String): String = "(?:non|nicht|icke)[-–]?(?:$qualifiers)\\p{L}{0,2}|(?:$qualifiers)[-–]?\\s?(?:$FREE_FROM)"
private data class QualifierDomain(val qualifiers: String, val rules: Set<String>)
/** Words that must surround an exact-only alias for it to count inside a longer term ("frisches Ei", "Ei aus Freilandhaltung"). */
private data class WordContext(val before: Regex, val after: Regex)
private fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }
// A substitute, flavour or culture word only covers its own phrase ("natural flavouring and milk powder" contains milk powder).
private const val MODIFIERS = "vegan\\w*|plant|plant-based|pflanzlich\\w*|växtbaserad\\w*|vegetabilisk\\w*|faux|fake|artificial|künstlich\\w*|synthetic\\w*|synthetisch\\w*|kunst\\w*|konst\\w*|syntet\\w*|imitation\\w*|imitiert\\w*|imitat|ersatz|alternative|alternativ|ersättning|erstatning|substitute|replacer|flavou?r\\w*|aroma\\w*|ar[oô]m\\w*|geschmack\\w*|smak\\w*|saveur\\w*|go[uû]t\\w*|sabor\\w*|gusto\\w*|smaak\\w*|smag\\w*|maku\\w*|vegaan\\w*|(?<!\\p{L})(?:cultures?|kultur\\w*)"
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
    private fun extendedTerms(key: String): List<String> = extendedMatching.getJSONArray(key).strings().map(::normalizeCompositionTerm)
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
    // A qualified negation keeps covering the following ingredient within the qualifier's domain ("dairy-free egg noodles" keeps the egg); the domains are data, and an empty domain covers every rule.
    private val qualifierDomains = extendedMatching.getJSONObject("animalQualifiers").let { domains ->
        domains.keys().asSequence().map { key ->
            val domain = domains.getJSONObject(key)
            QualifierDomain(domain.getJSONArray("qualifiers").strings().map(::normalizeCompositionTerm).joinToString("|"), domain.getJSONArray("rules").strings().toSet())
        }.toList()
    }
    private val animalQualifiers = qualifierDomains.joinToString("|") { it.qualifiers }
    private val domainNegations = qualifierDomains.map { Regex("^(?:${qualified(it.qualifiers)})$") to it.rules }
    private val negations = "${qualified(animalQualifiers)}|$NEGATIONS"
    private val negatedBefore = Regex("(?:^|[^\\p{L}])(?:$negations)(?:$|[^\\p{L}])")
    private val negationWord = Regex("(?:^|[^\\p{L}])(?:$negations)(?=$|[^\\p{L}])")
    /** An alias that reads as a negation or modifier itself ("pflanzlich gegerbtes Leder") or doubles as a word of another language ("ei": Finnish "not", Romanian "they") only matches exactly; inside longer text it is as likely an OCR fragment as an egg. */
    private val exactOnlyAliases = extendedTerms("exactOnlyAliases").toSet()
    private fun readsAsModifier(alias: String): Boolean = alias in exactOnlyAliases || negatedBefore.containsMatchIn(alias) || modifiedBefore.containsMatchIn(alias)
    /** A listed context lets an exact-only alias count as a word: a German adjective before it or a German preposition after it ("frisches Ei", "Ei aus Freilandhaltung"). */
    private val exactOnlyContexts = extendedMatching.getJSONArray("exactOnlyContexts").let { items ->
        (0 until items.length()).map { index ->
            val context = items.getJSONObject(index)
            val alias = normalizeCompositionTerm(context.getString("alias"))
            alias to WordContext(Regex("(?:^|[^\\p{L}\\p{N}])(?:${context.getString("before")})\\s+$"), Regex("^\\s+(?:${context.getString("after")})(?=$|[^\\p{L}\\p{N}])"))
        }
    }
    private val animalAliases = aliasRules.filterValues { it.getString("status") == "animal" }.keys.filterNot(::readsAsModifier).sortedByDescending { it.length }
    /** Hosts allowed to settle a web claim as certification evidence (shared with the TypeScript core). */
    internal val veganCertifiers: Set<String> = rulesDocument.optJSONArray("veganCertifiers")?.let { items -> (0 until items.length()).map { items.getString(it) }.toSet() }.orEmpty()
    /** The last negation before the mention still covers it unless it names another domain or a plant or ambiguous ingredient (or the hyphenated word) closed its scope without a conjunction reopening it. */
    private fun negated(before: String, ruleId: String): Boolean {
        val last = negationWord.findAll(before).lastOrNull() ?: return false
        val rules = domainNegations.firstOrNull { (pattern, _) -> pattern.matches(last.value.trimStart { !it.isLetter() }) }?.second
        if (!rules.isNullOrEmpty() && ruleId !in rules) return false
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
    /** The text within the scope window before and after a mention, cut back to word boundaries. */
    private fun scopeAround(text: String, start: Int, end: Int): Pair<String, String> {
        var from = maxOf(0, start - SCOPE_WINDOW)
        var to = minOf(text.length, end + SCOPE_WINDOW)
        if (from > 0) while (from < start && wordCharacter.matches(text[from - 1].toString())) from++
        if (to < text.length) while (to > end && wordCharacter.matches(text[to].toString())) to--
        return text.substring(from, start) to text.substring(end, to)
    }
    /** The item occurs (as a whole word, or as a compound stem forming a component) without a negation or modifier covering that occurrence. */
    private fun mentioned(text: String, item: String, wholeWord: Boolean, context: WordContext? = null): Boolean {
        var start = text.indexOf(item)
        while (start >= 0) {
            val end = start + item.length
            val (before, after) = scopeAround(text, start, end)
            val boundary = if (wholeWord) !wordCharacter.containsMatchIn(text.getOrNull(start - 1)?.toString().orEmpty()) && !wordCharacter.containsMatchIn(text.getOrNull(end)?.toString().orEmpty())
                else component(before.takeLastWhile { it.isLetter() }.length, item, after.takeWhile { it.isLetter() }.length)
            val inContext = { context == null || context.before.containsMatchIn(before) || context.after.containsMatchIn(after) }
            val blocked = {
                negated(before.split(phrase).last(), aliasRules[item]?.getString("id").orEmpty()) || modifiedBefore.containsMatchIn(before.split(conjunct).last()) ||
                    freed(after.split(phrase).first()) || modifiedAfter.containsMatchIn(after.split(conjunct).first())
            }
            if (boundary && inContext() && !blocked()) return true
            start = text.indexOf(item, start + 1)
        }
        return false
    }
    /** How far whole-word animal alias occurrences reach: `at[i]` from an occurrence starting at `i`, `before[i]` from any occurrence starting earlier. One scan per term keeps stripping thousands of exceptions near-linear. */
    private class AnimalReach(val at: IntArray, val before: IntArray)
    private fun animalReach(term: String): AnimalReach {
        val at = IntArray(term.length + 1)
        val before = IntArray(term.length + 1)
        for (alias in animalAliases) {
            var start = term.indexOf(alias)
            while (start >= 0) {
                val end = start + alias.length
                val whole = !wordCharacter.containsMatchIn(term.getOrNull(start - 1)?.toString().orEmpty()) && !wordCharacter.containsMatchIn(term.getOrNull(end)?.toString().orEmpty())
                if (whole) at[start] = maxOf(at[start], end)
                start = term.indexOf(alias, start + 1)
            }
        }
        for (index in 1..term.length) before[index] = maxOf(before[index - 1], at[index - 1])
        return AnimalReach(at, before)
    }
    /** A plant exception is blanked where it starts a word ("oat milk powder", not "goat milk powder") or follows a compound modifier of at least three letters ("walnut butter", "Tomatfruktkött"), unless a whole-word animal alias starts before it and reaches into it ("Griskött" over "skött") or starts with it and outgrows it ("Fischgräten" over "Fischgrät"); an inflection or compound tail after it keeps its plant head ("beef tomatoes", "king oysters", "Hafermilchkonzentrat"). Blanks keep the term's length, so the reach measured once on the term stays aligned. */
    private fun withoutPlantExceptions(term: String): String {
        val reach by lazy { animalReach(term) }
        var value = term
        for (exception in plantExceptions) {
            var start = value.indexOf(exception)
            while (start >= 0) {
                val end = start + exception.length
                var prefix = 0
                while (value.getOrNull(start - prefix - 1)?.isLetter() == true) prefix++
                if (component(prefix, exception, 0) && reach.before[start] <= start && reach.at[start] <= end) value = value.take(start) + " ".repeat(exception.length) + value.substring(end)
                start = value.indexOf(exception, start + 1)
            }
        }
        return value
    }
    /** An exact alias wins; otherwise an unmodified animal alias as a whole word, or a compound stem, inside the term identifies the rule. */
    private fun ruleForTerm(term: String): JSONObject? {
        // E numbers come spaced, hyphenated or with a roman subgroup ("e-471", "e500ii").
        (aliasRules[term] ?: additiveNumber.matchEntire(term)?.let { aliasRules["e${it.groupValues[1]}"] })?.let { return it }
        val remainder = withoutPlantExceptions(term)
        val alias = animalAliases.firstOrNull { mentioned(remainder, it, true) }
            ?: exactOnlyContexts.firstOrNull { (contextAlias, context) -> mentioned(remainder, contextAlias, true, context) }?.first
            ?: compoundStems.firstOrNull { mentioned(remainder, it, false) }
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
