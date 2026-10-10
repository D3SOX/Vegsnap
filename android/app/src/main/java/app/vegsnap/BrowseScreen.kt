package app.vegsnap

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ArrowDropDown
import androidx.compose.material.icons.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal data class BrowseState(val source: BrowseSource = BrowseSource.FOOD, val query: String = "",
    val submitted: String = "", val page: BrowsePage? = null, val cursors: List<Int> = listOf(0),
    val loading: Boolean = false, val error: BrowseFailure? = null)

internal class BrowseViewModel(application: android.app.Application) : androidx.lifecycle.AndroidViewModel(application) {
    private val repository = BrowseRepository(offlineDatabase = ApplicationOfflineDatabase.get(application))
    private val mutableState = MutableStateFlow(BrowseState())
    val state = mutableState.asStateFlow()
    private var request: Job? = null
    private var generation = 0
    fun query(value: String) { mutableState.update { it.copy(query = value.take(200)) } }
    fun source(value: BrowseSource) {
        cancel()
        mutableState.update { BrowseState(source = value, query = it.query) }
    }
    fun cancel() { generation++; request?.cancel(); mutableState.update { it.copy(loading = false) } }
    fun offline(value: Boolean) { cancel(); mutableState.update { it.copy(page = null, error = null) } }
    fun search(offline: Boolean, locale: String, direction: Int = 0) {
        val current = state.value
        val query = if (direction == 0) current.query.trim() else current.submitted
        if (offline && current.source in setOf(BrowseSource.WIKIDATA, BrowseSource.BARNIVORE) || query.length < 2 || current.loading) return
        val cursors = when {
            direction > 0 -> current.page?.next?.let { current.cursors + it } ?: return
            direction < 0 -> current.cursors.dropLast(1).takeIf { it.isNotEmpty() } ?: return
            else -> listOf(0)
        }
        cancel()
        val version = generation
        mutableState.update { it.copy(loading = true, error = null) }
        request = viewModelScope.launch {
            try {
                val page = repository.search(current.source, query, cursors.last(), locale, offline)
                if (version == generation) mutableState.update { it.copy(submitted = query, page = page, cursors = cursors, loading = false) }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                if (version == generation) mutableState.update { it.copy(loading = false, error = (error as? BrowseException)?.reason ?: BrowseFailure.UNAVAILABLE) }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun BrowseScreen(settings: AppSettings, model: VegsnapViewModel) {
    val browser: BrowseViewModel = viewModel()
    val state by browser.state.collectAsStateWithLifecycle()
    val scan by model.state.collectAsStateWithLifecycle()
    val keyboard = LocalSoftwareKeyboardController.current
    val uriHandler = LocalUriHandler.current
    var sourceMenu by remember { mutableStateOf(false) }
    var detail by remember { mutableStateOf<BrowseRecord?>(null) }
    var externalSources by remember { mutableStateOf(false) }
    var linkError by remember { mutableStateOf(false) }
    val available = !settings.offline || state.source !in setOf(BrowseSource.WIKIDATA, BrowseSource.BARNIVORE)
    val locale = LocalConfiguration.current.locales[0]?.language?.takeIf { it in setOf("en", "de") } ?: "en"
    LaunchedEffect(settings.offline) { browser.offline(settings.offline) }
    DisposableEffect(browser) { onDispose { browser.cancel() } }
    fun search(direction: Int = 0) { keyboard?.hide(); browser.search(settings.offline, locale, direction) }
    fun open(url: String) { runCatching { uriHandler.openUri(url) }.onFailure { linkError = true } }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp),
        contentPadding = PaddingValues(vertical = 16.dp)) {
        item { AlternativeSearchButton(model, market = settings.fallbackCountry) }
        item {
            Box {
                OutlinedButton(onClick = { sourceMenu = true }, modifier = Modifier.fillMaxWidth()) {
                    Text(state.source.title, Modifier.weight(1f)); Icon(Icons.Outlined.ArrowDropDown, stringResource(R.string.browse_choose_source))
                }
                DropdownMenu(sourceMenu, { sourceMenu = false }) {
                    BrowseSource.entries.forEach { source -> DropdownMenuItem(text = { Text(source.title) }, onClick = {
                        browser.source(source); sourceMenu = false
                    }) }
                }
            }
        }
        item {
            OutlinedTextField(state.query, browser::query, modifier = Modifier.fillMaxWidth(), singleLine = true,
                label = { Text(stringResource(if (state.source == BrowseSource.WIKIDATA) R.string.browse_identity_query else R.string.browse_product_query)) },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = { search() }))
        }
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Button(onClick = { search() }, enabled = available && !state.loading && state.query.trim().length >= 2, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Outlined.Search, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.browse_search))
                }
                if (state.loading) TextButton(onClick = browser::cancel) { Text(stringResource(R.string.cancel)) }
            }
        }
        if (settings.offline) item { Text(stringResource(if (available) R.string.offline_snapshot_notice else R.string.browse_offline), color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (state.loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()); Text(stringResource(R.string.browse_loading), style = MaterialTheme.typography.bodySmall) }
        state.error?.let { failure -> item { Text(stringResource(when (failure) {
            BrowseFailure.OFFLINE -> R.string.browse_offline
            BrowseFailure.RATE_LIMITED -> R.string.browse_rate_limited
            BrowseFailure.TEMPORARILY_UNAVAILABLE -> R.string.browse_temporarily_unavailable
            BrowseFailure.TIMEOUT -> R.string.browse_timeout
            BrowseFailure.CONNECTION -> R.string.browse_connection_error
            BrowseFailure.UNAVAILABLE -> R.string.browse_error
        }), color = MaterialTheme.colorScheme.error) } }
        item { Text(stringResource(when (state.source) { BrowseSource.WIKIDATA -> R.string.browse_identity_notice; BrowseSource.BARNIVORE -> R.string.barnivore_notice; else -> R.string.browse_community_notice }), style = MaterialTheme.typography.bodySmall) }
        state.page?.let { page ->
            item { Text(stringResource(R.string.browse_results_for, state.submitted), style = MaterialTheme.typography.titleSmall) }
            page.snapshotInfo?.forEach { info -> item { Text(stringResource(R.string.offline_pack_summary, info.region, info.count, info.generatedAt.take(10)), style = MaterialTheme.typography.bodySmall) } }
            if (page.records.isEmpty()) item { Text(stringResource(if (page.snapshotInfo != null) R.string.offline_snapshot_empty else R.string.browse_empty)) }
            items(page.records, key = { "${it.source}:${it.id}" }) { record ->
                OutlinedCard(onClick = { detail = record }, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(record.name, style = MaterialTheme.typography.titleMedium)
                        if (record.brand.isNotBlank()) Text(record.brand, style = MaterialTheme.typography.bodyMedium)
                        if (record.quantity.isNotBlank()) Text(record.quantity, style = MaterialTheme.typography.bodySmall)
                        if (record.description.isNotBlank()) Text(record.description, style = MaterialTheme.typography.bodyMedium)
                        if (record.markets.isNotBlank()) Text(record.markets, style = MaterialTheme.typography.bodySmall)
                        Text("${record.source.title} · ${record.source.license}", style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
            item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { search(-1) }, enabled = available && !state.loading && state.cursors.size > 1) { Text(stringResource(R.string.browse_previous)) }
                    Text(stringResource(R.string.browse_page, state.cursors.size), style = MaterialTheme.typography.labelMedium)
                    TextButton(onClick = { search(1) }, enabled = available && !state.loading && page.next != null) { Text(stringResource(R.string.browse_next)) }
                }
            }
        }
        item {
            HorizontalDivider()
            TextButton(onClick = { externalSources = !externalSources }) { Text(stringResource(R.string.browse_other_sources)) }
        }
        if (externalSources) {
            item { Text(stringResource(R.string.browse_external_notice), style = MaterialTheme.typography.bodySmall) }
            items(externalBrowseSources) { source ->
                OutlinedButton(onClick = { open(source.url) }, enabled = !settings.offline, modifier = Modifier.fillMaxWidth()) {
                    Text(source.name, Modifier.weight(1f)); Icon(Icons.Outlined.OpenInNew, stringResource(R.string.browse_external))
                }
            }
            item { Text(stringResource(R.string.browse_manufacturer), style = MaterialTheme.typography.bodySmall) }
        }
        if (linkError) item { Text(stringResource(R.string.browse_open_error), color = MaterialTheme.colorScheme.error) }
    }
    detail?.let { record ->
        VegsnapBottomSheet(onDismissRequest = { detail = null }) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(record.name, style = MaterialTheme.typography.headlineSmall)
                Text("${record.source.title} · ${record.source.license}", style = MaterialTheme.typography.bodySmall)
                BrowseField(R.string.browse_brand, record.brand)
                BrowseField(R.string.barcode, record.barcode)
                BrowseField(R.string.browse_markets, record.markets)
                BrowseField(R.string.browse_quantity, record.quantity)
                BrowseField(if (record.source == BrowseSource.BARNIVORE) R.string.barnivore_status else R.string.browse_labels, record.labels)
                BrowseField(R.string.browse_description, record.description)
                if (record.source !in setOf(BrowseSource.WIKIDATA, BrowseSource.BARNIVORE)) BrowseField(R.string.browse_composition,
                    record.composition.ifBlank { stringResource(R.string.browse_no_composition) })
                BrowseField(if (record.source == BrowseSource.BARNIVORE) R.string.barnivore_copied else R.string.browse_updated, record.updated)
                if (record.snapshotDate.isNotBlank()) Text(stringResource(R.string.offline_snapshot_date, record.snapshotDate.take(10)))
                Text(stringResource(when (record.source) { BrowseSource.WIKIDATA -> R.string.browse_identity_notice; BrowseSource.BARNIVORE -> R.string.barnivore_notice; else -> R.string.browse_community_notice }), style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { open(record.url) }, enabled = !settings.offline) {
                    Text(stringResource(R.string.browse_source_page)); Spacer(Modifier.width(8.dp)); Icon(Icons.Outlined.OpenInNew, null)
                }
                Button(onClick = {
                    val input = record.manualInput(settings.defaultCategory)
                    model.clearPhotos()
                    model.update { it.copy(text = input.text, name = input.name, barcode = input.barcode, category = input.category,
                        photos = emptyList(), complete = false, textTruncated = false, result = null, focusedJob = null) }
                    detail = null
                    model.selectTab("manual")
                }, enabled = !scan.busy && !scan.capturing, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.browse_use_manual)) }
                TextButton(onClick = { detail = null }) { Text(stringResource(R.string.close)) }
            }
        }
    }
}

@Composable
private fun BrowseField(label: Int, value: String) {
    if (value.isNotBlank()) Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(stringResource(label), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}
internal data class ExternalBrowseSource(val name: String, val url: String)
internal val externalBrowseSources = listOf(
    ExternalBrowseSource("V-Label", "https://www.v-label.com/"),
    ExternalBrowseSource("The Vegan Society", "https://www.vegansociety.com/resources/lifestyle/shopping/trademark-search"),
    ExternalBrowseSource("Vegan Action", "https://vegan.org/certified-products/"),
)
