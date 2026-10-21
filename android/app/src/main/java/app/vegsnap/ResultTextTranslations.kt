package app.vegsnap

import org.json.JSONArray
import org.json.JSONObject

/** Presentation copy only. Never reinterpret an outcome or translate original source evidence. */
internal class ResultTextTranslations(document: JSONObject, rules: JSONObject) {
    private val translations = buildMap<String, JSONObject> {
        val terms = document.getJSONArray("terms")
        for (index in 0 until terms.length()) {
            val pair = terms.getJSONObject(index)
            for (language in appLanguages) pair.optString(language).takeIf { it.isNotBlank() }?.let { put(it, pair) }
        }
        val entries = rules.getJSONArray("rules")
        for (index in 0 until entries.length()) {
            val pair = entries.getJSONObject(index).getJSONObject("explanation")
            for (language in appLanguages) pair.optString(language).takeIf { it.isNotBlank() }?.let { put(it, pair) }
        }
    }
    // Rule explanations exist in English and German only; other languages read the English text.
    private fun text(value: String, locale: String): String = translations[value]?.let { it.optString(locale).ifBlank { it.optString("en") } }?.takeIf { it.isNotBlank() } ?: value
    fun localize(source: JSONObject, locale: String): JSONObject {
        val language = appLanguage(locale)
        val result = JSONObject(source.toString())
        if (result.has("summary")) result.put("summary", text(result.getString("summary"), language))
        for (field in listOf("warnings", "questions")) {
            val values = result.optJSONArray(field) ?: JSONArray()
            for (index in 0 until values.length()) values.put(index, text(values.getString(index), language))
        }
        val findings = result.optJSONArray("findings") ?: JSONArray()
        for (index in 0 until findings.length()) {
            val item = findings.getJSONObject(index)
            item.put("explanation", text(item.getString("explanation"), language))
        }
        val errorCode = result.optJSONObject("aiError")?.optString("code")
        AIErrorCode.entries.firstOrNull { it.code == errorCode }?.let { result.put("aiError", it.json(language, hosted = result.optJSONObject("aiError")?.opt("hosted") == true)) }
        // Product names, original evidence, cross-contact text and free-form AI explanations stay verbatim.
        return result
    }
}
