package org.veguide.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class MainActivity : ComponentActivity() {
    private val model: VeguideViewModel by viewModels()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (savedInstanceState == null) receive(intent)
        setContent { VeguideApp(model) }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); receive(intent) }
    @Suppress("DEPRECATION")
    private fun receive(intent: Intent) {
        if (intent.action == AnalysisQueueService.ACTION_HISTORY) { model.openQueueHistory(); return }
        if (intent.action == Intent.ACTION_VIEW && isChatGPTAppReturn(intent.dataString)) {
            model.returnFromChatGPT()
            return
        }
        if (intent.action != Intent.ACTION_SEND) return
        if (intent.type?.startsWith("image/") == true) {
            val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
            if (uri != null && uri.scheme == "content") { model.sharedPhotos(listOf(uri)) }
        } else intent.getStringExtra(Intent.EXTRA_TEXT)?.let(model::sharedText)
    }
}

internal val categories = linkedMapOf("other" to R.string.auto_category, "food" to R.string.food, "drink" to R.string.drink, "cosmetics" to R.string.cosmetics,
    "household" to R.string.household, "clothing" to R.string.clothing, "shoes" to R.string.shoes)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VeguideApp(model: VeguideViewModel) {
    val state by model.state.collectAsStateWithLifecycle()
    val settings by model.settings.collectAsStateWithLifecycle()
    val tab by model.tab.collectAsStateWithLifecycle()
    val history by model.history.collectAsStateWithLifecycle()
    val queue by model.queuedJobs.collectAsStateWithLifecycle()
    val pending = queue
    val itemCount = (history.map { it.id } + pending.map { it.historyId ?: it.id }).distinct().size
    val context = LocalContext.current
    val tourPreferences = remember(context) { context.getSharedPreferences("onboarding", android.content.Context.MODE_PRIVATE) }
    var showTour by rememberSaveable { mutableStateOf(!tourPreferences.getBoolean("completed", false)) }
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(state.notificationRequest) {
        if (state.notificationRequest > 0 && android.os.Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            val prompts = context.getSharedPreferences("notification-prompts", android.content.Context.MODE_PRIVATE)
            if (!prompts.getBoolean("analysis-requested", false)) {
                prompts.edit().putBoolean("analysis-requested", true).apply()
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }
    val scheme = if (android.os.Build.VERSION.SDK_INT >= 31) {
        if (isSystemInDarkTheme()) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
    } else if (isSystemInDarkTheme()) darkColorScheme(primary = Color(0xFFA7D4AF), secondary = Color(0xFFBDCDBE))
        else lightColorScheme(primary = Color(0xFF355D40), secondary = Color(0xFF526453), surface = Color(0xFFF7F9F3))
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(state.message) { state.message?.let { snackbar.showSnackbar(context.getString(it)); model.update { s -> s.copy(message = null) } } }
    MaterialTheme(colorScheme = scheme) {
        if (showTour) OnboardingScreen {
            tourPreferences.edit().putBoolean("completed", true).apply()
            showTour = false
        } else {
        Scaffold(topBar = { CenterAlignedTopAppBar(title = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Image(painterResource(R.drawable.ic_veguide), contentDescription = null,
                    modifier = Modifier.size(32.dp).clip(RoundedCornerShape(8.dp)))
                Text(stringResource(R.string.app_name))
            }
        }) }, snackbarHost = { SnackbarHost(snackbar) },
            bottomBar = { NavigationBar {
                listOf(Triple("scan", R.string.scan, Icons.Outlined.CameraAlt), Triple("manual", R.string.manual, Icons.Outlined.EditNote), Triple("history", R.string.history, Icons.Outlined.History), Triple("browse", R.string.browse, Icons.Outlined.TravelExplore), Triple("settings", R.string.settings_tab, Icons.Outlined.Settings)).forEach { (key, title, icon) ->
                    val historyCount = stringResource(R.string.history_count, itemCount)
                    NavigationBarItem(selected = tab == key, onClick = { model.selectTab(key) }, modifier = Modifier.semantics {
                        if (key == "history") stateDescription = historyCount
                    }, icon = {
                        BadgedBox(badge = {
                            if (key == "history" && (history.isNotEmpty() || pending.isNotEmpty())) {
                                Badge { Text((itemCount).toString()) }
                            }
                        }) { Icon(icon, contentDescription = null) }
                    }, label = { Text(stringResource(title)) })
                }
            } }) { padding ->
            Box(Modifier.padding(padding).fillMaxSize()) {
                when (tab) {
                    "history" -> HistoryScreen(history, pending, settings.offline, model)
                    "settings" -> SettingsScreen(settings, model) { showTour = true }
                    "browse" -> BrowseScreen(settings, model)
                    "manual" -> ManualScreen(state, model)
                    else -> ScanScreen(state, model)
                }
            }
        }
        pending.firstOrNull { it.id == state.focusedJob }?.let { job ->
            VeguideBottomSheet(onDismissRequest = model::dismissProgress) {
                Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    QueueJobContent(job, model, settings.offline)
                    Button(onClick = model::dismissProgress, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.continue_scanning)) }
                    Spacer(Modifier.height(16.dp))
                }
            }
        }
        state.result?.let { json ->
            val selectedResult = JSONObject(json)
            val failedRetry = pending.firstOrNull { it.historyId == selectedResult.optString("id") && it.status == AnalysisStatus.FAILED }
            VeguideBottomSheet(onDismissRequest = { model.update { it.copy(result = null) } }) {
                ResultSheet(selectedResult, { model.update { it.copy(result = null) } }, { model.retryHistory(selectedResult) }, {
                    model.update { it.copy(result = null) }
                    model.selectTab("settings")
                }, model, failedRetry)
            }
        }
        }
    }
}

@Composable
private fun HistoryScreen(entries: List<HistoryEntry>, pending: List<AnalysisJob>, offline: Boolean, model: VeguideViewModel) {
    var query by rememberSaveable { mutableStateOf("") }
    var deleteAll by remember { mutableStateOf(false) }
    val export = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { it?.let(model::export) }
    val import = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(model::import) }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { OutlinedTextField(query, { query = it }, label = { Text(stringResource(R.string.search_history)) }, modifier = Modifier.fillMaxWidth()) }
        item { Row {
            TextButton(onClick = { export.launch("veguide-history.json") }, enabled = entries.isNotEmpty()) { Text(stringResource(R.string.export_history)) }
            TextButton(onClick = { import.launch(arrayOf("application/json")) }) { Text(stringResource(R.string.import_history)) }
        } }
        item { Text(stringResource(R.string.history_notice), style = MaterialTheme.typography.bodySmall) }
        items(pending.filter { job -> entries.none { it.id == job.historyId } && job.title.contains(query, ignoreCase = true) }, key = { "queue:${it.id}" }) { job ->
            ElevatedCard(onClick = { model.focusJob(job.id) }) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { QueueJobContent(job, model, offline, compact = true) }
            }
        }
        if (entries.isEmpty() && pending.isEmpty()) item { Text(stringResource(R.string.empty_history), Modifier.padding(vertical = 32.dp)) }
        items(entries.filter { it.title.contains(query, ignoreCase = true) }, key = { it.id }) { entry ->
            ElevatedCard(onClick = { model.open(entry) }) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    pending.firstOrNull { it.historyId == entry.id }?.let { job -> QueueJobContent(job, model, offline, compact = true, showIdentity = false) }
                    HistoryPhotoStrip(entry.id, model)
                    Text(entry.title, style = MaterialTheme.typography.titleMedium, maxLines = 2)
                    val result = JSONObject(entry.json)
                    ResultStatusLabel(resultClassification(result.optString("outcome"), result.optString("basis")))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(entry.checkedAt.take(16).replace('T', ' '), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                        IconButton(onClick = { model.delete(entry.id) }) { Icon(Icons.Outlined.Delete, stringResource(R.string.delete)) }
                    }
                }
            }
        }
        if (entries.isNotEmpty()) item { TextButton(onClick = { deleteAll = true }) { Text(stringResource(R.string.delete_all), color = MaterialTheme.colorScheme.error) } }
        item { Spacer(Modifier.height(16.dp)) }
    }
    if (deleteAll) AlertDialog(onDismissRequest = { deleteAll = false }, text = { Text(stringResource(R.string.delete_confirm)) },
        confirmButton = { TextButton(onClick = { model.deleteAll(); deleteAll = false }) { Text(stringResource(R.string.delete)) } },
        dismissButton = { TextButton(onClick = { deleteAll = false }) { Text(stringResource(R.string.cancel)) } })
}

@Composable
private fun HistoryPhotoStrip(id: String, model: VeguideViewModel) {
    val photos by produceState<List<Uri>>(emptyList(), id) { value = model.savedPhotos(id) }
    var preview by remember(id) { mutableStateOf<Uri?>(null) }
    if (photos.isNotEmpty()) Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        photos.forEachIndexed { index, uri ->
            PhotoImage(uri, stringResource(R.string.photo_number, index + 1),
                Modifier.size(80.dp).clip(RoundedCornerShape(12.dp)).clickable { preview = uri })
        }
    }
    preview?.let { PhotoGallery(photos, it, enabled = true, onRemove = null) { preview = null } }
}

@Composable
private fun PrivateAccountEmail(email: String) {
    var revealed by remember(email) { mutableStateOf(false) }
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner, email) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_PAUSE || event == Lifecycle.Event.ON_STOP) revealed = false
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer); revealed = false }
    }
    val action = stringResource(if (revealed) R.string.hide_account_email else R.string.show_account_email)
    val privacyState = stringResource(if (revealed) R.string.account_email_visible else R.string.account_email_hidden)
    OutlinedButton(onClick = { revealed = !revealed }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics {
        contentDescription = action
        stateDescription = privacyState
    }) {
        // RenderEffect blur is unavailable before Android 12. Never show real text there while hidden.
        val display = if (revealed || android.os.Build.VERSION.SDK_INT >= 31) email else "••••••••@••••••••"
        Text(display, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f)
            .then(if (revealed) Modifier else Modifier.blur(12.dp).clearAndSetSemantics { }))
        Spacer(Modifier.width(12.dp))
        Icon(if (revealed) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, contentDescription = null)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SettingsScreen(settings: AppSettings, model: VeguideViewModel, onTour: () -> Unit) {
    val token by model.apiToken.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val chatGPT by model.chatGPTState.collectAsStateWithLifecycle()
    var modelMenu by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var startMenu by remember { mutableStateOf(false) }
    val presets = linkedMapOf("OpenAI" to "https://api.openai.com/v1", "OpenRouter" to "https://openrouter.ai/api/v1",
        "Gemini" to "https://generativelanguage.googleapis.com/v1beta/openai", "Ollama" to "http://127.0.0.1:11434/v1")
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        ToggleRow(stringResource(R.string.offline), settings.offline, { enabled -> model.updateSettings { it.copy(offline = enabled) } })
        OfflineDatabaseSettings(model)
        HorizontalDivider()
        Text(stringResource(R.string.provider), style = MaterialTheme.typography.titleLarge)
        Text(stringResource(R.string.provider_hint))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(settings.connection == "chatgpt", { model.updateSettings { it.copy(connection = "chatgpt") } }, label = { Text("ChatGPT") }, enabled = !settings.offline)
            FilterChip(settings.connection == "api", { model.updateSettings { it.copy(connection = "api") } }, label = { Text(stringResource(R.string.api_connection)) }, enabled = !settings.offline)
        }
        ToggleRow(stringResource(R.string.enable_ai), settings.aiEnabled && !settings.offline, { enabled -> model.updateSettings { it.copy(aiEnabled = enabled) } }, enabled = !settings.offline)
        if (settings.connection == "chatgpt") {
            Text(stringResource(R.string.chatgpt), style = MaterialTheme.typography.bodySmall)
            if (chatGPT.connected) {
                Text(stringResource(R.string.chatgpt_connected))
                if (chatGPT.email.isNotBlank()) PrivateAccountEmail(chatGPT.email)
                FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box {
                        OutlinedButton(onClick = { modelMenu = true }, modifier = Modifier.heightIn(min = 48.dp),
                            enabled = !settings.offline && !chatGPT.busy && chatGPT.models.isNotEmpty()) {
                            Text(chatGPT.models.firstOrNull { it.id == settings.chatgptModel }?.name
                                ?: settings.chatgptModel.ifBlank { stringResource(R.string.select_model) },
                                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                            Spacer(Modifier.width(4.dp))
                            Icon(Icons.Outlined.ArrowDropDown, contentDescription = null)
                        }
                        DropdownMenu(modelMenu, { modelMenu = false }) { chatGPT.models.forEach { entry ->
                            DropdownMenuItem(text = { Text(entry.name) }, enabled = !settings.offline,
                                onClick = { model.updateSettings { it.copy(chatgptModel = entry.id) }; modelMenu = false })
                        } }
                    }
                    OutlinedButton(onClick = { model.loadChatGPTModels() }, modifier = Modifier.heightIn(min = 48.dp),
                        enabled = !chatGPT.busy && !settings.offline) {
                        Text(stringResource(if (chatGPT.models.isEmpty()) R.string.load_models else R.string.refresh_models))
                    }
                    TextButton(onClick = { model.disconnectChatGPT() }, modifier = Modifier.heightIn(min = 48.dp), enabled = !settings.offline) {
                        Text(stringResource(R.string.chatgpt_disconnect))
                    }
                    TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://chatgpt.com/settings/usage"))) },
                        modifier = Modifier.heightIn(min = 48.dp), enabled = !settings.offline) { Text(stringResource(R.string.chatgpt_usage)) }
                }
                if (!settings.offline && settings.aiEnabled && settings.chatgptModel.isBlank()) {
                    Text(stringResource(R.string.model_required), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            } else {
                Button(onClick = { model.connectChatGPT { url -> context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } },
                    modifier = Modifier.heightIn(min = 48.dp), enabled = !chatGPT.busy && !settings.offline) { Text(stringResource(R.string.chatgpt_continue)) }
                if (!settings.offline && settings.aiEnabled && !chatGPT.busy) {
                    Text(stringResource(R.string.chatgpt_setup_required), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            }
            if (chatGPT.busy) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                TextButton(onClick = { model.cancelChatGPT() }, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.cancel)) }
            }
            chatGPT.message?.let { Text(stringResource(it), color = MaterialTheme.colorScheme.error) }
        } else {
        Box {
            OutlinedButton(onClick = { menu = true }, enabled = !settings.offline) { Text(presets.entries.firstOrNull { it.value == settings.baseUrl }?.key ?: "Custom") }
            DropdownMenu(menu, { menu = false }) { presets.forEach { (title, url) ->
                DropdownMenuItem(text = { Text(title) }, enabled = !settings.offline, onClick = { model.updateSettings { it.copy(baseUrl = url, model = "") }; menu = false })
            } }
        }
        val invalidUrl = !settings.offline && !validEndpoint(settings.baseUrl)
        OutlinedTextField(settings.baseUrl, { url -> model.updateSettings { it.copy(baseUrl = url.trim()) } }, label = { Text(stringResource(R.string.base_url)) }, enabled = !settings.offline, singleLine = true, modifier = Modifier.fillMaxWidth(),
            isError = invalidUrl, supportingText = if (invalidUrl) ({ Text(stringResource(R.string.endpoint_error)) }) else null)
        OutlinedTextField(token, { model.updateApiToken(settings.baseUrl, it) }, label = { Text(stringResource(R.string.token)) }, enabled = !settings.offline, visualTransformation = PasswordVisualTransformation(), singleLine = true, modifier = Modifier.fillMaxWidth())
        val missingModel = !settings.offline && settings.aiEnabled && settings.model.isBlank()
        OutlinedTextField(settings.model, { value -> model.updateSettings { it.copy(model = value.trim()) } }, label = { Text(stringResource(R.string.model)) }, enabled = !settings.offline, singleLine = true, modifier = Modifier.fillMaxWidth(),
            isError = missingModel, supportingText = if (missingModel) ({ Text(stringResource(R.string.model_required)) }) else null)
        TextButton(onClick = { model.disconnect() }, enabled = !settings.offline) { Text(stringResource(R.string.disconnect)) }
        }
        if ((if (settings.connection == "chatgpt") settings.chatgptModel else settings.model).isNotBlank()) {
            Text(stringResource(when (modelVisionSupport(settings, chatGPT.models)) {
                true -> R.string.vision
                false -> R.string.vision_unsupported
                null -> R.string.vision_unknown
            }), style = MaterialTheme.typography.bodySmall)
        }
        Text(stringResource(R.string.private_model), style = MaterialTheme.typography.bodySmall)
        Text(stringResource(R.string.parallel_checks, settings.parallelChecks), style = MaterialTheme.typography.titleMedium)
        var parallelValue by remember(settings.parallelChecks) { mutableFloatStateOf(settings.parallelChecks.toFloat()) }
        Slider(value = parallelValue, onValueChange = { parallelValue = it }, valueRange = 1f..10f, steps = 8,
            onValueChangeFinished = { model.updateSettings { it.copy(parallelChecks = kotlin.math.round(parallelValue).toInt().coerceIn(1, 10)) } },
            modifier = Modifier.semantics { contentDescription = context.getString(R.string.parallel_checks, kotlin.math.round(parallelValue).toInt()) })
        Text(stringResource(R.string.parallel_checks_hint), style = MaterialTheme.typography.bodySmall)
        HorizontalDivider()
        OcrLanguageSettings(model, settings.offline)
        HorizontalDivider()
        Text(stringResource(R.string.market))
        var categoryMenu by remember { mutableStateOf(false) }
        // Intrinsic widths let translated labels and larger system text determine
        // when the second control wraps, rather than relying on a screen breakpoint.
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp), maxItemsInEachRow = 2) {
            Column(Modifier.widthIn(min = 148.dp).width(IntrinsicSize.Max), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val label = stringResource(R.string.default_category)
                val value = stringResource(categories[settings.defaultCategory] ?: R.string.auto_category)
                Text(label, style = MaterialTheme.typography.labelMedium)
                Box {
                    OutlinedButton(onClick = { categoryMenu = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                        .semantics { contentDescription = "$label: $value" }) {
                        Icon(categoryIcon(settings.defaultCategory), null, Modifier.size(20.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(value, Modifier.weight(1f))
                        Spacer(Modifier.width(4.dp))
                        Icon(Icons.Outlined.ArrowDropDown, null, Modifier.size(20.dp))
                    }
                    DropdownMenu(categoryMenu, { categoryMenu = false }) {
                        categories.forEach { (key, title) ->
                            DropdownMenuItem(text = { Text(stringResource(title)) },
                                leadingIcon = { Icon(categoryIcon(key), null) }, onClick = {
                                    model.updateSettings { it.copy(defaultCategory = key) }; categoryMenu = false
                                })
                        }
                    }
                }
            }
            Column(Modifier.widthIn(min = 148.dp).width(IntrinsicSize.Max), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val label = stringResource(R.string.start_tab)
                val value = stringResource(when (settings.startTab) {
                    "manual" -> R.string.manual; "history" -> R.string.history; "last" -> R.string.last_tab; else -> R.string.scan
                })
                Text(label, style = MaterialTheme.typography.labelMedium)
                Box {
                    OutlinedButton(onClick = { startMenu = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                        .semantics { contentDescription = "$label: $value" }) {
                        Icon(startTabIcon(settings.startTab), null, Modifier.size(20.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(value, Modifier.weight(1f))
                        Spacer(Modifier.width(4.dp))
                        Icon(Icons.Outlined.ArrowDropDown, null, Modifier.size(20.dp))
                    }
                    DropdownMenu(startMenu, { startMenu = false }) {
                        listOf("scan" to R.string.scan, "manual" to R.string.manual, "history" to R.string.history, "last" to R.string.last_tab).forEach { (key, title) ->
                            DropdownMenuItem(text = { Text(stringResource(title)) }, leadingIcon = { Icon(startTabIcon(key), null) }, onClick = {
                                model.updateSettings { it.copy(startTab = key) }; startMenu = false
                            })
                        }
                    }
                }
            }
        }
        OutlinedButton(onClick = onTour) { Icon(Icons.Outlined.AutoStories, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.tour_replay)) }
        Text(stringResource(R.string.privacy), style = MaterialTheme.typography.titleLarge)
        Text(stringResource(R.string.privacy_text))
        Text(stringResource(R.string.sources), style = MaterialTheme.typography.titleLarge)
        Text(stringResource(R.string.source_text), style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun OcrLanguageSettings(model: VeguideViewModel, offline: Boolean) {
    val state by model.ocrState.collectAsStateWithLifecycle()
    val message by model.ocrMessage.collectAsStateWithLifecycle()
    val scan by model.state.collectAsStateWithLifecycle()
    var showLanguages by rememberSaveable { mutableStateOf(false) }
    Text(stringResource(R.string.ocr_languages), style = MaterialTheme.typography.titleLarge)
    Text(stringResource(R.string.ocr_hint), style = MaterialTheme.typography.bodySmall)
    if (!state.ready) LinearProgressIndicator(Modifier.fillMaxWidth())
    message?.let { Text(stringResource(it), color = MaterialTheme.colorScheme.error) }
    if (offline) Text(stringResource(R.string.ocr_offline), style = MaterialTheme.typography.bodySmall)
    val busy = state.downloading != null || scan.busy || !state.ready
    for (language in OCR_LANGUAGES.filter { it.bundled }) {
        OcrLanguageCard(language, state, busy, offline, model)
    }
    val displayLocale = LocalConfiguration.current.locales[0]
    val enabled = OCR_LANGUAGES.filter { it.code in state.selected }.joinToString(", ") { ocrLanguageTitle(it, displayLocale) }
    Text(stringResource(R.string.ocr_enabled, enabled), style = MaterialTheme.typography.bodySmall)
    if (!showLanguages) OCR_LANGUAGES.firstOrNull { it.code == state.downloading }?.let { language ->
        Text(ocrLanguageTitle(language, displayLocale), style = MaterialTheme.typography.titleSmall)
        OcrDownloadProgress(language, state, model)
    }
    TextButton(onClick = { showLanguages = true }) { Text(stringResource(R.string.ocr_more)) }
    if (showLanguages) AlertDialog(
        onDismissRequest = { showLanguages = false },
        title = { Text(stringResource(R.string.ocr_more)) },
        text = {
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 480.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item { Text(stringResource(R.string.ocr_download_hint), style = MaterialTheme.typography.bodySmall) }
                if (offline) item { Text(stringResource(R.string.ocr_offline), style = MaterialTheme.typography.bodySmall) }
                message?.let { item { Text(stringResource(it), color = MaterialTheme.colorScheme.error) } }
                items(OCR_LANGUAGES.filter { !it.bundled }, key = { it.code }) { language ->
                    OcrLanguageCard(language, state, busy, offline, model)
                }
            }
        },
        confirmButton = { TextButton(onClick = { showLanguages = false }) { Text(stringResource(R.string.close)) } },
    )
}

private fun ocrLanguageTitle(language: OcrLanguage, displayLocale: java.util.Locale): String {
    val localized = java.util.Locale.forLanguageTag(language.tag).getDisplayName(displayLocale)
    return if (localized.equals(language.nativeName, ignoreCase = true)) language.nativeName else "$localized · ${language.nativeName}"
}

@Composable
private fun OcrLanguageCard(language: OcrLanguage, state: OcrLanguageState, busy: Boolean, offline: Boolean, model: VeguideViewModel) {
    val title = ocrLanguageTitle(language, LocalConfiguration.current.locales[0])
    val size = android.text.format.Formatter.formatShortFileSize(LocalContext.current, language.bytes)
    val selected = language.code in state.selected
    val installed = language.code in state.installed
    val canToggle = !busy && (!selected || state.selected.size > 1)
    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).then(if (installed) Modifier.toggleable(
                value = selected, enabled = canToggle, role = Role.Checkbox,
                onValueChange = { model.setOcrLanguage(language.code, it) },
            ) else Modifier), verticalAlignment = Alignment.CenterVertically) {
                Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                if (installed) Checkbox(checked = selected, onCheckedChange = null, enabled = canToggle)
            }
            Text(stringResource(if (language.bundled) R.string.ocr_bundled else if (installed) R.string.ocr_installed else R.string.ocr_download_size, size),
                style = MaterialTheme.typography.bodySmall)
            when {
                state.downloading == language.code -> OcrDownloadProgress(language, state, model)
                !installed -> OutlinedButton(onClick = { model.downloadOcrLanguage(language.code) }, enabled = !busy && !offline) {
                    Text(stringResource(R.string.ocr_download))
                }
                !language.bundled -> TextButton(onClick = { model.removeOcrLanguage(language.code) },
                    enabled = !busy && (!selected || state.selected.size > 1)) { Text(stringResource(R.string.ocr_remove)) }
            }
        }
    }
}

@Composable
private fun OcrDownloadProgress(language: OcrLanguage, state: OcrLanguageState, model: VeguideViewModel) {
    val progress = (state.downloadedBytes.toFloat() / language.bytes).coerceIn(0f, 1f)
    LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
    Text(stringResource(R.string.ocr_progress, (progress * 100).toInt()), style = MaterialTheme.typography.bodySmall)
    TextButton(onClick = model::cancelOcrDownload) { Text(stringResource(R.string.cancel)) }
}

@Composable
internal fun ToggleRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit, enabled: Boolean = true) {
    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onChange), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f).padding(end = 12.dp), color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (enabled) 1f else 0.38f)); Switch(checked, onCheckedChange = null, enabled = enabled)
    }
}

private fun JSONArray.strings() = (0 until length()).map { getString(it) }
@Composable
private fun ResultSheet(originalResult: JSONObject, onClose: () -> Unit, onRecheck: () -> Unit, onSettings: () -> Unit, model: VeguideViewModel, failedRetry: AnalysisJob? = null) {
    val context = LocalContext.current
    val locale = LocalConfiguration.current.locales[0].language.let { if (it == "de") "de" else "en" }
    val result = remember(originalResult.toString(), locale) { localizeResultTerms(context, originalResult, locale) }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        ResultStatusLabel(resultClassification(result.getString("outcome"), result.optString("basis")), prominent = true)
        Text(result.getString("title"), style = MaterialTheme.typography.titleLarge)
        HistoryPhotoStrip(result.getString("id"), model)
        Text(result.getString("summary"))
        val aiStatus = result.optString("aiStatus")
        val aiStatusText = when (aiStatus) {
            "not_needed" -> R.string.ai_status_not_needed
            "disabled" -> R.string.ai_status_disabled
            "offline" -> R.string.ai_status_offline
            "unconfigured" -> R.string.ai_status_unconfigured
            "vision_disabled" -> R.string.ai_status_vision_disabled
            "failed" -> R.string.ai_status_failed
            "text" -> R.string.ai_status_text
            "images" -> R.string.ai_status_images
            else -> if (result.optBoolean("usedAI")) R.string.ai_status_used else null
        }
        aiStatusText?.let { Text(stringResource(it), style = MaterialTheme.typography.bodyMedium,
            color = if (aiStatus == "failed") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant) }
        (failedRetry?.failureReason?.json(locale)?.optString("message") ?: result.optJSONObject("aiError")?.optString("message"))?.takeIf { it.isNotBlank() }?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }
        if (failedRetry?.failureReason == AIErrorCode.QUOTA && failedRetry.settings.connection == "chatgpt") {
            TextButton(onClick = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://chatgpt.com/settings/usage"))) } }) {
                Text(stringResource(R.string.chatgpt_usage))
            }
        }
        val webSearchText = when (result.optString("webSearchStatus")) {
            "searched" -> R.string.web_search_used
            "unsupported" -> R.string.web_search_unsupported
            else -> null
        }
        webSearchText?.let { Text(stringResource(it), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (aiStatus in setOf("disabled", "unconfigured", "vision_disabled")) {
            TextButton(onClick = onSettings) { Text(stringResource(R.string.ai_settings)) }
        }
        result.optJSONArray("warnings")?.strings()?.distinct()?.forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
        val findings = result.optJSONArray("findings") ?: JSONArray()
        for (index in 0 until findings.length()) {
            val item = findings.getJSONObject(index)
            if (item.optString("status") != "plant") {
                val original = item.getString("term")
                val display = item.optString("displayTerm").ifBlank { original }
                Text(display + " — " + item.getString("explanation"))
                if (display != original) Text(stringResource(R.string.ingredient_original, original), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        result.optJSONArray("questions")?.strings()?.takeIf { it.isNotEmpty() }?.let { questions ->
            Text(stringResource(R.string.questions), style = MaterialTheme.typography.titleMedium); questions.forEach { Text(it) }
        }
        result.optJSONArray("crossContact")?.strings()?.takeIf { it.isNotEmpty() }?.let { values ->
            Text(stringResource(R.string.cross_contact), style = MaterialTheme.typography.titleMedium); values.forEach { Text(it) }
        }
        val evidence = result.optJSONArray("evidence") ?: JSONArray()
        if (evidence.length() > 0) Text(stringResource(R.string.evidence), style = MaterialTheme.typography.titleMedium)
        for (index in 0 until evidence.length()) {
            val item = evidence.getJSONObject(index)
            OutlinedCard { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(item.getString("title"), style = MaterialTheme.typography.titleSmall)
                Text(item.optString("excerpt"), style = MaterialTheme.typography.bodySmall)
                val url = item.optString("url")
                if (url.startsWith("https://")) TextButton(onClick = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } }) { Text(Uri.parse(url).host ?: url) }
                Text(item.optString("retrievedAt").take(10), style = MaterialTheme.typography.labelSmall)
            } }
        }
        ManufacturerContactSection(result)
        CompanyConcernSection(result)
        TextButton(onClick = { model.recheck(originalResult) }) { Icon(Icons.Outlined.EditNote, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.edit_result)) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(modifier = Modifier.weight(1f), contentPadding = PaddingValues(horizontal = 8.dp, vertical = 10.dp), onClick = {
            context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, result.getString("title") + "\n" + result.getString("summary")) }, null))
        }) { Text(stringResource(R.string.copy_result)) }
        Button(modifier = Modifier.weight(1.2f), contentPadding = PaddingValues(horizontal = 8.dp, vertical = 10.dp), onClick = onRecheck) { Text(stringResource(R.string.recheck)) }
        TextButton(modifier = Modifier.weight(.8f), contentPadding = PaddingValues(horizontal = 4.dp, vertical = 10.dp), onClick = onClose) { Text(stringResource(R.string.close)) }
        }
        Spacer(Modifier.height(24.dp))
    }
}

private fun startTabIcon(tab: String) = when (tab) {
    "manual" -> Icons.Outlined.EditNote
    "history" -> Icons.Outlined.History
    "last" -> Icons.Outlined.Restore
    else -> Icons.Outlined.CameraAlt
}
