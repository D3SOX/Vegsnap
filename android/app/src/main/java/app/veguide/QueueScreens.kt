package app.veguide

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

internal fun AnalysisJob.statusLabel(): Int = when (status) {
    AnalysisStatus.QUEUED -> R.string.queue_waiting
    AnalysisStatus.RUNNING -> stage?.label ?: R.string.progress_preparing
    AnalysisStatus.PAUSED -> R.string.queue_paused
    AnalysisStatus.FAILED -> R.string.queue_failed
    AnalysisStatus.INTERRUPTED -> R.string.queue_interrupted
    AnalysisStatus.CANCELLED -> R.string.queue_cancelled
}

@Composable
internal fun QueueJobContent(job: AnalysisJob, model: VeguideViewModel, offline: Boolean, compact: Boolean = false, showIdentity: Boolean = true) {
    val photos by produceState<List<Uri>>(emptyList(), job.id) { value = if (showIdentity) model.queuedPhotos(job.id) else emptyList() }
    var preview by remember(job.id) { mutableStateOf<Uri?>(null) }
    if (photos.isNotEmpty()) Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        photos.forEachIndexed { index, uri -> PhotoImage(uri, stringResource(R.string.photo_number, index + 1),
            Modifier.size(if (compact) 56.dp else 80.dp).clip(RoundedCornerShape(12.dp)).clickable { preview = uri }) }
    }
    if (showIdentity) Text(job.title.ifBlank { if (job.photoCount > 0) pluralStringResource(R.plurals.queue_photos, job.photoCount, job.photoCount) else stringResource(R.string.check) }, style = MaterialTheme.typography.titleMedium, maxLines = 2)
    Text(stringResource(job.statusLabel()), color = MaterialTheme.colorScheme.primary)
    if (job.status == AnalysisStatus.FAILED) job.failureReason?.let { reason ->
        Text(if (LocalConfiguration.current.locales[0]?.language == "de") reason.german else reason.english,
            color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        if (reason == AIErrorCode.QUOTA && job.settings.connection == "chatgpt") {
            val context = LocalContext.current
            TextButton(enabled = !offline, onClick = {
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://chatgpt.com/settings/usage"))) }
            }) { Text(stringResource(R.string.chatgpt_usage)) }
        }
    }
    if (job.status == AnalysisStatus.RUNNING) {
        LinearProgressIndicator(Modifier.fillMaxWidth())
        val elapsed by produceState(0L, job.startedAt) {
            while (true) { value = ((System.currentTimeMillis() - (job.startedAt ?: System.currentTimeMillis())) / 1000).coerceAtLeast(0); delay(1000) }
        }
        Text(stringResource(R.string.progress_elapsed, elapsed / 60, elapsed % 60), style = MaterialTheme.typography.bodySmall)
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        if (job.status in listOf(AnalysisStatus.FAILED, AnalysisStatus.INTERRUPTED, AnalysisStatus.CANCELLED, AnalysisStatus.PAUSED)) {
            TextButton(onClick = { model.retryJob(job.id) }, enabled = !offline || job.settings.offline || job.result != null) { Text(stringResource(R.string.queue_retry)) }
        }
        if (job.status in listOf(AnalysisStatus.QUEUED, AnalysisStatus.RUNNING, AnalysisStatus.PAUSED)) {
            TextButton(onClick = { model.cancelJob(job.id) }, enabled = job.stage != CheckStage.SAVING) { Text(stringResource(R.string.cancel)) }
        } else IconButton(onClick = { model.removeJob(job.id) }) { Icon(Icons.Outlined.Delete, stringResource(R.string.delete)) }
    }
    preview?.let { PhotoGallery(photos, it, enabled = true, onRemove = null) { preview = null } }
}
