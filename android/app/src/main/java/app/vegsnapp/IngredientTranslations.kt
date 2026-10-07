package app.vegsnapp

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Display names have no role in ingredient matching, evidence identity, or the vegan outcome. */
internal class IngredientTranslations {
    fun localize(source: JSONObject, locale: String): JSONObject {
        val language = if (locale == "de") "de" else "en"
        val result = JSONObject(source.toString())
        result.optJSONArray("findings")?.let { result.put("findings", withoutDatabaseRuleMisses(it, result.optJSONArray("evidence") ?: JSONArray())) }
        val findings = result.optJSONArray("findings") ?: JSONArray()
        val unresolved = linkedSetOf<String>()
        for (index in 0 until findings.length()) {
            val finding = findings.getJSONObject(index)
            val original = finding.getString("term")
            val aiName = (finding.opt("displayTerm") as? String)?.takeIf {
                finding.optString("displayLocale") == language && it.isNotBlank() && it.length <= 300
            }
            val display = aiName
            finding.remove("displayTerm"); finding.remove("displayLocale")
            if (display != null && display != original) finding.put("displayTerm", display).put("displayLocale", language)
            if (finding.optString("status") in setOf("unknown", "ambiguous")) unresolved += display ?: original
        }
        val questions = result.optJSONArray("questions") ?: JSONArray()
        val originQuestion = Regex("^(?:Confirm the origin of:|Die Herkunft dieser Zutaten klären:|Confirm the source of the ambiguous|Die Herkunft unklarer)")
        for (index in 0 until questions.length()) {
            if (unresolved.isNotEmpty() && originQuestion.containsMatchIn(questions.getString(index))) {
                questions.put(index, (if (language == "de") "Die Herkunft dieser Zutaten klären: " else "Confirm the origin of: ") + unresolved.joinToString(", ") + ".")
            }
        }
        return result
    }
}

private object BundledResultTextTranslations {
    private var instance: ResultTextTranslations? = null
    @Synchronized fun get(context: Context): ResultTextTranslations = instance ?: ResultTextTranslations(
        JSONObject(context.assets.open("result-translations.json").bufferedReader().use { it.readText() }),
        JSONObject(context.assets.open("rules.json").bufferedReader().use { it.readText() }),
    ).also { instance = it }
}
internal fun localizeResultTerms(context: Context, result: JSONObject, locale: String): JSONObject =
    BundledResultTextTranslations.get(context).localize(IngredientTranslations().localize(result, locale), locale)
