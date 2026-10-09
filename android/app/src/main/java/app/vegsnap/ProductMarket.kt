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
// Canonical Open Facts tags differing from system names. Keep in sync with core/market.ts.
// https://github.com/openfoodfacts/openfoodfacts-server/blob/main/taxonomies/countries.txt
private val countryAliases by lazy {
    Locale.getISOCountries().associateBy { productMarketTag(it).removePrefix("en:").replace("-", "") } +
        mapOf(
            "antarctic" to "AQ", "antiguaandbarbuda" to "AG", "bosniaandherzegovina" to "BA",
            "cocoskeelingislands" to "CC", "curacao" to "CW", "czechrepublic" to "CZ",
            "cotedivoire" to "CI", "democraticrepublicofthecongo" to "CD", "federatedstatesofmicronesia" to "FM",
            "frenchsouthernandantarcticlands" to "TF", "heardislandandmcdonaldislands" to "HM", "hongkong" to "HK",
            "macau" to "MO", "myanmar" to "MM", "pitcairn" to "PN",
            "republicofthecongo" to "CG", "reunion" to "RE", "sainthelena" to "SH",
            "saintkittsandnevis" to "KN", "saintlucia" to "LC", "saintmartin" to "MF",
            "saintpierreandmiquelon" to "PM", "saintvincentandthegrenadines" to "VC", "saintbarthelemy" to "BL",
            "saotomeandprincipe" to "ST", "southgeorgiaandthesouthsandwichislands" to "GS", "stateofpalestine" to "PS",
            "svalbardandjanmayen" to "SJ", "swaziland" to "SZ", "thebahamas" to "BS",
            "trinidadandtobago" to "TT", "turkey" to "TR", "turksandcaicosislands" to "TC",
            "unitedstatesminoroutlyingislands" to "UM", "virginislandsoftheunitedstates" to "VI", "wallisandfutuna" to "WF",
            "alandislands" to "AX",
        ) + mapOf("deutschland" to "DE", "sverige" to "SE", "suomi" to "FI", "uk" to "GB", "usa" to "US")
}
internal fun productCountryCode(value: String): String? = value.trim().uppercase(Locale.ROOT).takeIf(::validProductMarket)
    ?: countryAliases[value.trim().lowercase(Locale.ROOT).removePrefix("en:").replace(Regex("[\\s-]"), "")]
internal fun productCountryName(value: String, locale: Locale): String = productCountryCode(value)?.let {
    Locale.Builder().setRegion(it).build().getDisplayCountry(locale)
} ?: value
internal fun selectProductCountry(input: CheckInput, packagingCountry: String? = null, markets: List<String> = emptyList()): Pair<String, String> {
    if (input.autoMarket != true) return input.market to "manual"
    val packaging = packagingCountry?.let(::productCountryCode)
    val codes = markets.map(::productCountryCode)
    if (packagingCountry != null && packaging == null || codes.any { it == null } || packaging != null && codes.isNotEmpty() && packaging !in codes) return input.market to "fallback"
    if (packaging != null) return packaging to "packaging"
    val unique = codes.distinct().singleOrNull()
    return if (unique != null) unique to "database" else input.market to "fallback"
}
internal fun databaseCountryWarning(market: String, markets: List<String>, locale: String): String? = when {
    markets.isEmpty() -> if (locale == "de") "Dieser Datensatz bestätigt das Produktland nicht. Vergleiche die Rezeptur mit deiner Packung." else "This record does not confirm the product country. Compare its composition with your package."
    markets.none { productCountryCode(it) == market } -> if (locale == "de") "Dieser Datensatz nennt andere Märkte als $market. Vergleiche die Rezeptur mit deiner Packung." else "This record lists other markets than $market. Compare its composition with your package."
    else -> null
}

@Composable
internal fun ProductMarketButton(market: String, enabled: Boolean = true, modifier: Modifier = Modifier,
    source: String? = null, onSave: suspend (String) -> Boolean) {
    var editing by remember { mutableStateOf(false) }
    var value by remember(market) { mutableStateOf(productCountryCode(market) ?: market) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val locale = LocalConfiguration.current.locales[0]
    val country = productCountryName(market, locale)
    OutlinedButton(onClick = { value = productCountryCode(market) ?: market; editing = true }, enabled = enabled, modifier = modifier) {
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
