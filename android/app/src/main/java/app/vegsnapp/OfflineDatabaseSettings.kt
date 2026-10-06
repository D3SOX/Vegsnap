package app.vegsnapp

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.time.Instant

@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)
@Composable
internal fun OfflineDatabaseSettings(model: VegsnapViewModel) {
    val state by model.offlineData.collectAsStateWithLifecycle()
    val downloads by model.regionalPackState.collectAsStateWithLifecycle()
    val settings by model.settings.collectAsStateWithLifecycle()
    val busy by model.offlineDataBusy.collectAsStateWithLifecycle()
    val message by model.offlineDataMessage.collectAsStateWithLifecycle()
    var showRegions by rememberSaveable { mutableStateOf(false) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { model.importOfflinePack(it) } }
    Text(stringResource(R.string.offline_data), style = MaterialTheme.typography.titleMedium)
    Text(stringResource(R.string.offline_snapshot_notice), style = MaterialTheme.typography.bodySmall)
    if (!state.ready || busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    state.bundled?.let { info ->
        Text(stringResource(R.string.offline_bundled), style = MaterialTheme.typography.labelLarge)
        PackSummary(info)
    }
    if (state.installed.isNotEmpty()) Text(stringResource(R.string.offline_imported), style = MaterialTheme.typography.labelLarge)
    state.installed.forEach { info ->
        OutlinedCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                PackSummary(info)
                TextButton(enabled = !busy, onClick = { model.removeOfflinePack(info.id) }) { Text(stringResource(R.string.offline_pack_remove)) }
            }
        }
    }
    if (state.unavailable) Text(stringResource(R.string.offline_data_unavailable), color = MaterialTheme.colorScheme.error)
    Text(stringResource(R.string.offline_pack_hint), style = MaterialTheme.typography.bodySmall)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(enabled = state.ready && downloads.ready && !busy, onClick = {
            showRegions = true
            if (downloads.packs.isEmpty() && !settings.offline) model.refreshRegionalPacks(downloads.catalogUrl)
        }) { Icon(Icons.Outlined.Public, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.offline_regions)) }
        TextButton(enabled = state.ready && !busy, onClick = { picker.launch(arrayOf("application/json", "application/octet-stream", "text/plain")) }) {
            Text(stringResource(R.string.offline_pack_import))
        }
    }
    message?.let { Text(stringResource(it), color = MaterialTheme.colorScheme.error) }
    if (showRegions) RegionalPacksSheet(state, downloads, settings.offline, busy, message,
        onRefresh = model::refreshRegionalPacks, onCancel = model::cancelRegionalDownload,
        onDownload = model::downloadRegionalPack, onDismiss = { showRegions = false })
}

@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)
@Composable
internal fun RegionalPacksSheet(
    state: OfflineDatabaseState,
    downloads: RegionalPacksState,
    offline: Boolean,
    busy: Boolean,
    message: Int?,
    onRefresh: (String) -> Unit,
    onCancel: () -> Unit,
    onDownload: (String) -> Unit,
    onDismiss: () -> Unit,
    dragHandle: @Composable () -> Unit = { BottomSheetDefaults.DragHandle() },
) {
    var editSource by rememberSaveable { mutableStateOf(false) }
    var sourceUrl by remember(downloads.catalogUrl) { mutableStateOf(downloads.catalogUrl) }
    VegsnapBottomSheet(onDismissRequest = onDismiss, dragHandle = dragHandle) {
        LazyColumn(Modifier.testTag("regional-packs").fillMaxWidth().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(bottom = 24.dp)) {
            item { Text(stringResource(R.string.offline_regions), style = MaterialTheme.typography.headlineSmall) }
            item { Text(stringResource(R.string.offline_download_notice), style = MaterialTheme.typography.bodySmall) }
            if (offline) item { Text(stringResource(R.string.offline_download_disabled), style = MaterialTheme.typography.bodyMedium) }
            item {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(enabled = !busy && !offline, onClick = { onRefresh(downloads.catalogUrl) }) {
                        Icon(Icons.Outlined.Refresh, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.offline_catalog_refresh))
                    }
                    TextButton(onClick = { editSource = !editSource }, enabled = !busy) { Text(stringResource(R.string.offline_catalog_source)) }
                }
            }
            if (editSource) item {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(sourceUrl, { sourceUrl = it.take(2000) }, label = { Text(stringResource(R.string.offline_catalog_url)) },
                        modifier = Modifier.fillMaxWidth(), enabled = !busy, singleLine = true,
                        isError = sourceUrl.isNotBlank() && !validPackUrl(sourceUrl.trim()))
                    Text(stringResource(R.string.offline_catalog_recipient), style = MaterialTheme.typography.bodySmall)
                    TextButton(enabled = !busy && !offline && validPackUrl(sourceUrl.trim()), onClick = { onRefresh(sourceUrl) }) {
                        Text(stringResource(R.string.offline_catalog_use))
                    }
                }
            }
            if (downloads.loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            if (downloads.loading || downloads.downloading != null) item {
                TextButton(onClick = onCancel) { Text(stringResource(R.string.cancel)) }
            }
            message?.let { resource -> item { Text(stringResource(resource), color = MaterialTheme.colorScheme.error) } }
            if (!downloads.loading && downloads.packs.isEmpty()) item { Text(stringResource(R.string.offline_catalog_empty)) }
            items(downloads.packs, key = { it.id }) { pack ->
                val installed = state.installed.firstOrNull { it.id == offlineRegionId(pack.region) }
                val current = installed?.sha256 == pack.sha256 || installed != null && Instant.parse(installed.generatedAt) > Instant.parse(pack.generatedAt)
                OutlinedCard(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(pack.region, style = MaterialTheme.typography.titleMedium)
                        Text(stringResource(R.string.offline_download_summary, pack.products, pack.bytes / 1_000_000.0, pack.generatedAt.take(10)), style = MaterialTheme.typography.bodySmall)
                        if (downloads.downloading == pack.id) {
                            LinearProgressIndicator(progress = { (downloads.downloadedBytes.toFloat() / pack.bytes).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                            Text(stringResource(R.string.offline_download_progress, downloads.downloadedBytes / 1_000_000.0, pack.bytes / 1_000_000.0), style = MaterialTheme.typography.labelMedium)
                        } else if (current) Text(stringResource(R.string.offline_download_installed), style = MaterialTheme.typography.labelLarge)
                        else OutlinedButton(onClick = { onDownload(pack.id) },
                            enabled = !busy && !offline && (installed != null || state.installed.size < OFFLINE_INSTALLED_PACKS)) {
                            Icon(Icons.Outlined.Download, null); Spacer(Modifier.width(8.dp))
                            Text(stringResource(if (installed == null) R.string.offline_download else R.string.offline_download_update))
                        }
                    }
                }
            }
            item { TextButton(onClick = onDismiss) { Text(stringResource(R.string.close)) } }
        }
    }
}

@Composable
private fun PackSummary(info: OfflinePackInfo) {
    Text(stringResource(R.string.offline_pack_summary, info.region, info.count, info.generatedAt.take(10)), style = MaterialTheme.typography.bodySmall)
    Text(info.sources + " · ODbL-1.0", style = MaterialTheme.typography.bodySmall)
}
