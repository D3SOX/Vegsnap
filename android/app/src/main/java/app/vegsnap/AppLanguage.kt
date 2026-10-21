package app.vegsnap

/** UI languages with generated resources; other system languages read English copy. */
internal val appLanguages = setOf("en", "de", "sv")

internal fun appLanguage(code: String?): String = code?.takeIf { it in appLanguages } ?: "en"
