package app.vegsnapp

/** Keep a bounded prefix together with the information that its remainder was discarded. */
data class BoundedProductText(val text: String, val truncated: Boolean)
fun boundedProductText(value: String, limit: Int = 30_000) = BoundedProductText(value.take(limit), value.length > limit)
