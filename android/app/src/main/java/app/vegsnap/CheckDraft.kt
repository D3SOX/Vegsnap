package app.vegsnap

import org.json.JSONObject

internal fun canSendBarcodeToAI(result: JSONObject): Boolean {
    val evidence = result.optJSONArray("evidence")
    return result.optString("outcome") == "uncertain" && !result.optBoolean("usedAI") &&
        validGtin(result.optJSONObject("identity")?.optString("barcode").orEmpty()) &&
        (0 until (evidence?.length() ?: 0)).any { evidence?.optJSONObject(it)?.optString("kind") == "database" }
}

/** Keep original input separate from the evidence discovered during analysis. */
internal fun encodeDraftInput(input: CheckInput): JSONObject = JSONObject()
    .put("text", input.text).put("category", input.category).put("complete", input.complete)
    .put("name", input.name).put("barcode", input.barcode).put("locale", input.locale).put("truncated", input.truncated)
    .put("market", input.market)
    .put("autoMarket", input.autoMarket)

internal fun decodeDraftInput(value: JSONObject): CheckInput = CheckInput(
    text = value.getString("text"), category = value.getString("category"),
    complete = if (value.has("complete")) value.getBoolean("complete") else null,
    name = value.getString("name"), barcode = value.getString("barcode"), locale = value.getString("locale"),
    truncated = value.getBoolean("truncated"),
    market = value.optString("market", "DE"),
    autoMarket = if (value.has("autoMarket")) value.getBoolean("autoMarket") else null,
)

/** Imported/older results have no saved draft: never promote OCR or web evidence to supplied text. */
internal fun recheckInput(result: JSONObject): CheckInput {
    val evidence = result.optJSONArray("evidence")
    val supplied = (0 until (evidence?.length() ?: 0)).mapNotNull { evidence?.optJSONObject(it) }
        .filter { it.optString("kind") == "user_text" }.map { it.optString("excerpt") }.distinct().joinToString("\n")
    val bounded = boundedProductText(supplied)
    val identity = result.optJSONObject("identity")
    return CheckInput(text = bounded.text, category = result.optString("category", "other"),
        name = identity?.optString("name").orEmpty(),
        barcode = identity?.optString("barcode").orEmpty().takeIf(::validGtin).orEmpty(), truncated = bounded.truncated,
        market = identity?.optString("market", "DE") ?: "DE",
        autoMarket = if (identity?.optString("marketSource") == "manual") false else null)
}

/** A detected country is not the fallback for a new check; a manual correction is. */
internal fun restoreCheckInput(result: JSONObject, original: CheckInput?, fallbackCountry: String): CheckInput {
    val restored = recheckInput(result)
    val input = original?.copy(name = original.name.ifBlank { restored.name },
        barcode = original.barcode.ifBlank { restored.barcode }) ?: restored
    val manual = restored.autoMarket == false || original?.autoMarket == false
    val market = if (restored.autoMarket == false) restored.market else if (manual) input.market else fallbackCountry
    val normalizedMarket = productCountryCode(market)
    require(normalizedMarket != null && validProductMarket(normalizedMarket)) { "Invalid product country" }
    return input.copy(market = normalizedMarket, autoMarket = if (manual) false else null)
}
