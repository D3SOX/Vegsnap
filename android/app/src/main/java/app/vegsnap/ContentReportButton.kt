package app.vegsnap

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.json.JSONObject

@Composable
internal fun ContentReportButton(kind: String, offline: Boolean, contentId: String = "", initialText: String = "", result: JSONObject? = null,
    submit: (suspend (ContentReport) -> String)? = null) {
    val context = LocalContext.current
    val locale = LocalConfiguration.current.locales[0].language
    val origin = remember(context) { contentServiceOrigin(context) }
    if (origin == null && submit == null) return
    val repository = remember(origin) { origin?.let(::ContentReportsRepository) }
    var open by remember { mutableStateOf(false) }
    var text by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var reference by remember { mutableStateOf<String?>(null) }
    var failed by remember { mutableStateOf(false) }
    var job by remember { mutableStateOf<Job?>(null) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(offline) { if (offline) job?.cancel() }
    fun close() { job?.cancel(); open = false }
    val title = stringResource(when (kind) { "ai" -> R.string.report_ai; "result" -> R.string.report_result; else -> R.string.report_reply })
    TextButton(onClick = { text = initialText.take(8000); reason = ""; failed = false; reference = null; open = true },
        enabled = !offline, modifier = Modifier.heightIn(min = 48.dp)) { Text(title) }
    if (open) AlertDialog(onDismissRequest = ::close, title = { Text(title) }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (reference != null) {
                Text(stringResource(R.string.report_sent, reference!!), Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            } else {
                Text(stringResource(when (kind) { "ai" -> R.string.report_ai_notice; "result" -> R.string.report_result_notice; else -> R.string.report_reply_notice }))
                if (kind == "ai") OutlinedTextField(text, { text = it.take(8000) },
                    label = { Text(stringResource(R.string.report_text)) }, modifier = Modifier.fillMaxWidth(),
                    minLines = 3, maxLines = 6, enabled = !sending)
                OutlinedTextField(reason, { reason = it.take(2000) }, label = { Text(stringResource(if (kind == "result") R.string.report_result_reason else R.string.report_reason)) },
                    modifier = Modifier.fillMaxWidth(), minLines = 2, maxLines = 4, enabled = !sending)
                if (offline) Text(stringResource(R.string.report_offline))
                if (failed) Text(stringResource(R.string.report_failed), color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            }
        }
    }, confirmButton = {
        if (reference == null) TextButton(enabled = !sending && !offline && reason.isNotBlank() && (kind != "ai" || text.isNotBlank()), onClick = {
            sending = true; failed = false
            job = scope.launch {
                try {
                    val details = if (kind == "result") resultReport(requireNotNull(result), locale, appVersion(context)) else null
                    reference = (submit ?: { report -> repository!!.submit(report) })(ContentReport(kind, contentId, text, reason, details))
                }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { failed = true }
                finally { sending = false }
            }
        }) { Text(stringResource(if (sending) R.string.report_sending else R.string.report_send)) }
        else TextButton(onClick = ::close) { Text(stringResource(R.string.close)) }
    }, dismissButton = {
        if (reference == null) TextButton(onClick = ::close) { Text(stringResource(R.string.cancel)) }
    })
}

private fun appVersion(context: android.content.Context): String =
    runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: ""
