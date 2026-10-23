package app.vegsnap

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import java.text.Collator
import java.text.Normalizer
import java.util.Locale

internal fun countryFlag(code: String): String =
    productCountryCode(code)?.map { String(Character.toChars(0x1F1A5 + it.code)) }?.joinToString("").orEmpty()
private fun searchKey(value: String) = Normalizer.normalize(value, Normalizer.Form.NFD).replace(Regex("\\p{M}"), "").lowercase(Locale.ROOT)

@Composable
internal fun CountryPickerDialog(selected: String?, enabled: Boolean, onDismiss: () -> Unit, onSelect: (String) -> Unit) {
    val locale = LocalConfiguration.current.locales[0]
    val countries = remember(locale) {
        val collator = Collator.getInstance(locale)
        Locale.getISOCountries().map { it to productCountryName(it, locale) }.sortedWith(compareBy(collator) { it.second })
    }
    var query by remember { mutableStateOf("") }
    val matches = remember(countries, query) {
        val key = searchKey(query.trim())
        if (key.isEmpty()) countries else countries.filter { (code, name) -> searchKey(name).contains(key) || code.equals(key, ignoreCase = true) }
    }
    val list = rememberLazyListState(countries.indexOfFirst { it.first == selected }.coerceAtLeast(0))
    LaunchedEffect(query) { if (query.isNotEmpty()) list.scrollToItem(0) }
    AlertDialog(onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.product_country)) },
        text = { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.product_country_hint))
            OutlinedTextField(query, { query = it }, label = { Text(stringResource(R.string.search_countries)) }, singleLine = true, enabled = enabled,
                leadingIcon = { Icon(Icons.Outlined.Search, null) }, modifier = Modifier.fillMaxWidth())
            LazyColumn(Modifier.heightIn(max = 320.dp), state = list) {
                items(matches, key = { it.first }) { (code, name) ->
                    ListItem(headlineContent = { Text(name) }, leadingContent = { Text(countryFlag(code), style = MaterialTheme.typography.titleLarge) },
                        trailingContent = if (code == selected) { { Icon(Icons.Outlined.Check, null) } } else null,
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                        modifier = Modifier.selectable(code == selected, enabled, Role.RadioButton) { onSelect(code) })
                }
            }
        } },
        confirmButton = {},
        dismissButton = { TextButton(enabled = enabled, onClick = onDismiss) { Text(stringResource(R.string.cancel)) } })
}
