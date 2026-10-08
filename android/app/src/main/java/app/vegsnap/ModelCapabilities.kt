package app.vegsnap

import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/** Catalog metadata wins. An unknown model is tried with photos rather than silently blocked. */
internal fun knownModelVisionSupport(model: String, metadata: JSONObject? = null): Boolean? {
    for (field in listOf("supportsImages", "supports_image_input", "supports_vision")) {
        val value = metadata?.opt(field)
        if (value is Boolean) return value
    }
    val vision = metadata?.optJSONObject("capabilities")?.opt("vision")
    if (vision is Boolean) return vision
    val modalities = metadata?.opt("input_modalities") ?: metadata?.optJSONObject("architecture")?.opt("input_modalities")
    if (modalities is JSONArray && modalities.length() > 0 && (0 until modalities.length()).all { modalities.get(it) is String }) {
        return (0 until modalities.length()).any { modalities.getString(it).equals("image", ignoreCase = true) }
    }
    val id = model.lowercase(Locale.ROOT).trim().removePrefix("openai/")
    if (Regex("^(?:gpt-3\\.5(?:-|$)|gpt-4(?:-(?:0314|0613|32k)(?:-|$)|$)|o1-(?:mini|preview)(?:-|$)|o3-mini(?:-|$))").containsMatchIn(id)) return false
    if (Regex("^(?:gpt-4o(?:-|$)|gpt-4\\.(?:1|5)(?:-|$)|gpt-4-(?:turbo|vision)(?:-|$)|gpt-[56](?:[.-]|$)|o1(?:-|$)|o3(?:-|$)|o4-mini(?:-|$))").containsMatchIn(id)) return true
    return null
}
internal fun modelVisionSupport(settings: AppSettings, models: List<ChatGPTModel>): Boolean? =
    if (settings.connection == "chatgpt") models.firstOrNull { it.id == settings.chatgptModel }?.supportsVision ?: knownModelVisionSupport(settings.chatgptModel)
    else knownModelVisionSupport(settings.model)
