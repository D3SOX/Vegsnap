package org.veguide.android

import org.json.JSONObject

/** Keep original input separate from the evidence discovered during analysis. */
internal fun encodeDraftInput(input: CheckInput): JSONObject = JSONObject()
    .put("text", input.text).put("category", input.category).put("complete", input.complete)
    .put("name", input.name).put("barcode", input.barcode).put("locale", input.locale).put("truncated", input.truncated)

internal fun decodeDraftInput(value: JSONObject): CheckInput = CheckInput(
    text = value.getString("text"), category = value.getString("category"),
    complete = if (value.has("complete")) value.getBoolean("complete") else null,
    name = value.getString("name"), barcode = value.getString("barcode"), locale = value.getString("locale"),
    truncated = value.getBoolean("truncated"),
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
        barcode = identity?.optString("barcode").orEmpty().takeIf(::validGtin).orEmpty(), truncated = bounded.truncated)
}
