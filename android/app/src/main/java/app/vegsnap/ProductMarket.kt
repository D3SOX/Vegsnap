package app.vegsnap

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import java.util.Locale
import kotlinx.coroutines.launch

internal fun org.json.JSONArray?.stringValues(): List<String> = this?.let { values -> (0 until values.length()).map { values.optString(it) } }.orEmpty()

internal fun validProductMarket(value: String): Boolean = value in Locale.getISOCountries()
internal fun productMarketTag(value: String): String = "en:" + Locale.Builder().setRegion(value).build()
    .getDisplayCountry(Locale.ENGLISH).lowercase(Locale.ROOT).replace(' ', '-')
private val countryAliases by lazy {
    Locale.getISOCountries().associateBy { productMarketTag(it).removePrefix("en:").replace("-", "") } +
        mapOf("deutschland" to "DE", "sverige" to "SE", "suomi" to "FI", "uk" to "GB", "usa" to "US")
}
internal fun productCountryCode(value: String): String? = value.trim().uppercase(Locale.ROOT).takeIf(::validProductMarket)
    ?: countryAliases[value.trim().lowercase(Locale.ROOT).removePrefix("en:").replace(Regex("[\\s-]"), "")]
internal fun selectProductCountry(input: CheckInput, packagingCountry: String? = null, markets: List<String> = emptyList()): Pair<String, String> {
    if (input.autoMarket != true) return input.market to "manual"
    val packaging = packagingCountry?.let(::productCountryCode)
    val codes = markets.map(::productCountryCode)
    if (packagingCountry != null && packaging == null || codes.any { it == null } || packaging != null && codes.isNotEmpty() && packaging !in codes) return input.market to "fallback"
    if (packaging != null) return packaging to "packaging"
    val unique = codes.distinct().singleOrNull()
    return if (unique != null) unique to "database" else input.market to "fallback"
}

@Composable
internal fun ProductMarketButton(market: String, enabled: Boolean = true, modifier: Modifier = Modifier,
    source: String? = null, onSave: suspend (String) -> Boolean) {
    var editing by remember { mutableStateOf(false) }
    var value by remember(market) { mutableStateOf(market) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val locale = LocalConfiguration.current.locales[0]
    val country = Locale.Builder().setRegion(market).build().getDisplayCountry(locale)
    OutlinedButton(onClick = { value = market; editing = true }, enabled = enabled, modifier = modifier) {
        Column {
            Text(stringResource(R.string.product_country) + ": " + country + " (" + market + ")")
            source?.let { Text(stringResource(when (it) { "packaging" -> R.string.country_from_packaging; "database" -> R.string.country_from_database; "manual" -> R.string.country_manual; else -> R.string.country_fallback }), style = MaterialTheme.typography.labelSmall) }
        }
    }
    if (editing) AlertDialog(onDismissRequest = { if (!saving) editing = false },
        title = { Text(stringResource(R.string.product_country)) },
        text = { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.product_country_hint))
            OutlinedTextField(value, { value = it.uppercase(Locale.ROOT).filter { c -> c in 'A'..'Z' }.take(2) },
                label = { Text(stringResource(R.string.community_market)) }, singleLine = true, enabled = !saving,
                supportingText = { if (validProductMarket(value)) Text(Locale.Builder().setRegion(value).build().getDisplayCountry(locale)) })
        } },
        confirmButton = { TextButton(enabled = !saving && validProductMarket(value), onClick = {
            scope.launch { saving = true; try { if (onSave(value)) editing = false } finally { saving = false } }
        }) { Text(stringResource(R.string.save_product_country)) } },
        dismissButton = { TextButton(enabled = !saving, onClick = { editing = false }) { Text(stringResource(R.string.cancel)) } })
}
