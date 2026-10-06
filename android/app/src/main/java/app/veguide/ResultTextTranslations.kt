package app.veguide

import org.json.JSONArray
import org.json.JSONObject

/** Presentation copy only. Never reinterpret an outcome or translate original source evidence. */
internal class ResultTextTranslations(document: JSONObject, rules: JSONObject) {
    private val translations = buildMap<String, JSONObject> {
        val terms = document.getJSONArray("terms")
        for (index in 0 until terms.length()) {
            val pair = terms.getJSONObject(index)
            put(pair.getString("en"), pair); put(pair.getString("de"), pair)
        }
        val entries = rules.getJSONArray("rules")
        for (index in 0 until entries.length()) {
            val pair = entries.getJSONObject(index).getJSONObject("explanation")
            put(pair.getString("en"), pair); put(pair.getString("de"), pair)
        }
    }
    private fun text(value: String, locale: String): String = translations[value]?.getString(locale) ?: value
    fun localize(source: JSONObject, locale: String): JSONObject {
        val language = if (locale == "de") "de" else "en"
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
        AIErrorCode.entries.firstOrNull { it.code == errorCode }?.let { result.put("aiError", it.json(language)) }
        // Product names, original evidence, cross-contact text and free-form AI explanations stay verbatim.
        return result
    }
}
