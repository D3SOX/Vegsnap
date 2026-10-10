package app.vegsnap

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

private fun categoryLabel(value: String) = when (value) {
    "food" -> R.string.food; "drink" -> R.string.drink; "cosmetics" -> R.string.cosmetics; "household" -> R.string.household
    "clothing" -> R.string.clothing; "shoes" -> R.string.shoes; else -> R.string.other
}

@Composable
internal fun AlternativeSearchButton(model: VegsnapViewModel, initialQuery: String = "", category: String = "food", market: String = "DE", barcode: String = "") {
    var open by rememberSaveable { mutableStateOf(false) }
    OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.alternatives_title)) }
    if (open) VegsnapBottomSheet(onDismissRequest = { open = false }) {
        AlternativesScreen(model, initialQuery, category, market, barcode)
    }
}

@Composable
private fun AlternativesScreen(model: VegsnapViewModel, initialQuery: String, initialCategory: String, market: String, barcode: String) {
    val settings by model.settings.collectAsStateWithLifecycle()
    val locale = if (LocalConfiguration.current.locales[0].language == "de") "de" else "en"
    var query by rememberSaveable { mutableStateOf(initialQuery.take(200)) }
    var store by rememberSaveable { mutableStateOf("") }
    var category by rememberSaveable { mutableStateOf(initialCategory) }
    var categoryMenu by remember { mutableStateOf(false) }
    var items by remember { mutableStateOf(emptyList<VeganAlternative>()) }
    var searched by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var aiStage by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<Int?>(null) }
    var job by remember { mutableStateOf<Job?>(null) }
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    DisposableEffect(settings.offline, market, settings.connection, settings.model, settings.chatgptModel, settings.baseUrl) {
        onDispose { job?.cancel() }
    }
    LaunchedEffect(settings.offline, market, settings.connection, settings.model, settings.chatgptModel, settings.baseUrl) {
        job?.cancel(); busy = false; items = emptyList(); searched = false; failure = null
    }
    fun search() {
        if (settings.offline || busy || query.trim().length < 2) return
        val input = AlternativeQuery(query.trim(), store.trim(), category, market, locale, barcode)
        job = scope.launch {
            busy = true; searched = true; aiStage = false; failure = null; items = emptyList()
            var publicItems = emptyList<VeganAlternative>()
            try {
                try { publicItems = model.publicAlternatives(input); items = publicItems }
                catch (error: CancellationException) { throw error }
                catch (_: Exception) { failure = R.string.alternatives_failed }
                aiStage = true
                try { items = rankAlternatives(publicItems + model.researchAlternatives(input), input) }
                catch (error: CancellationException) { throw error }
                catch (_: Exception) { failure = R.string.alternatives_ai_failed }
            } finally { busy = false }
        }
    }
    Column(Modifier.fillMaxWidth().fillMaxHeight(.9f).verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(stringResource(R.string.alternatives_title), style = MaterialTheme.typography.titleLarge)
        Text(stringResource(R.string.alternatives_hint), style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(query, { query = it.take(200) }, modifier = Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.alternatives_query)) }, singleLine = true, enabled = !busy)
        OutlinedTextField(store, { store = it.take(100) }, modifier = Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.alternatives_store)) }, singleLine = true, enabled = !busy)
        Box {
            OutlinedButton(onClick = { categoryMenu = true }, enabled = !busy) { Text(stringResource(categoryLabel(category))) }
            DropdownMenu(categoryMenu, { categoryMenu = false }) { listOf("food", "drink", "cosmetics", "household", "clothing", "shoes", "other").forEach { value ->
                DropdownMenuItem(text = { Text(stringResource(categoryLabel(value))) }, onClick = { category = value; categoryMenu = false })
            } }
        }
        Text(stringResource(R.string.alternatives_country, market), style = MaterialTheme.typography.bodySmall)
        Button(onClick = ::search, enabled = !settings.offline && !busy && query.trim().length >= 2, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.alternatives_search)) }
        if (settings.offline) Text(stringResource(R.string.alternatives_offline))
        if (busy) {
            LinearProgressIndicator(Modifier.fillMaxWidth())
            Text(stringResource(if (aiStage) R.string.alternatives_ai_loading else R.string.alternatives_loading))
            TextButton(onClick = { job?.cancel() }) { Text(stringResource(R.string.cancel)) }
        }
        failure?.let { Text(stringResource(it), color = MaterialTheme.colorScheme.error) }
        if (searched && !busy && failure == null && items.isEmpty()) Text(stringResource(R.string.alternatives_empty))
        items.forEach { item ->
            OutlinedCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(item.name, style = MaterialTheme.typography.titleMedium)
                    if (item.brand.isNotBlank()) Text(item.brand)
                    Text(if (item.storeMatch) stringResource(R.string.alternatives_store_match, item.stores.joinToString(", ")) else stringResource(R.string.alternatives_store_unknown))
                    Text(if (item.source == "AI") stringResource(R.string.alternatives_ai_source) else stringResource(R.string.alternatives_database_label, item.source), style = MaterialTheme.typography.bodySmall)
                    if (!item.marketListed) Text(stringResource(R.string.alternatives_country_unknown), style = MaterialTheme.typography.bodySmall)
                    if (item.source == "AI") Text(item.evidence)
                    TextButton(onClick = { runCatching { uri.openUri(item.storeUrl.ifBlank { item.url }) }.onFailure { failure = R.string.alternatives_failed } }) { Text(stringResource(R.string.alternatives_source)) }
                    if (item.storeUrl.isNotBlank() && item.storeUrl != item.url) TextButton(onClick = { runCatching { uri.openUri(item.url) }.onFailure { failure = R.string.alternatives_failed } }) { Text(stringResource(R.string.alternatives_vegan_evidence)) }
                }
            }
        }
        Text(stringResource(R.string.alternatives_disclaimer), style = MaterialTheme.typography.bodySmall)
    }
}
