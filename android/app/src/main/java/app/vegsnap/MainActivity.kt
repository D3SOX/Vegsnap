package app.vegsnap

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
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ListAlt
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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextAlign
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
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val model: VegsnapViewModel by viewModels()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (savedInstanceState == null) receive(intent)
        setContent { VegsnapApp(model) }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); receive(intent) }
    override fun onResume() { super.onResume(); model.setActivityResumed(true); model.resumeHostedAI() }
    override fun onPause() { model.setActivityResumed(false); super.onPause() }
    @Suppress("DEPRECATION")
    private fun receive(intent: Intent) {
        if (intent.action == AnalysisQueueService.ACTION_HISTORY) { model.openQueueHistory(); return }
        if (intent.action == Intent.ACTION_VIEW && isChatGPTAppReturn(intent.dataString)) {
            model.returnFromChatGPT()
            return
        }
        if (intent.action == Intent.ACTION_VIEW && isHostedAIAppReturn(intent.dataString)) {
            model.returnFromHostedAI()
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
fun VegsnapApp(model: VegsnapViewModel) {
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
        if (showTour) OnboardingScreen(settings, model) {
            tourPreferences.edit().putBoolean("completed", true).apply()
            showTour = false
        } else {
        Scaffold(topBar = { CenterAlignedTopAppBar(title = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Image(painterResource(R.drawable.ic_vegsnap), contentDescription = null,
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
            VegsnapBottomSheet(onDismissRequest = model::dismissProgress) {
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
            VegsnapBottomSheet(onDismissRequest = { model.update { it.copy(result = null) } }) {
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
private fun HistoryScreen(entries: List<HistoryEntry>, pending: List<AnalysisJob>, offline: Boolean, model: VegsnapViewModel) {
    var query by rememberSaveable { mutableStateOf("") }
    var deleteAll by remember { mutableStateOf(false) }
    val export = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { it?.let(model::export) }
    val import = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(model::import) }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { OutlinedTextField(query, { query = it }, label = { Text(stringResource(R.string.search_history)) }, modifier = Modifier.fillMaxWidth()) }
        item { Row {
            TextButton(onClick = { export.launch("vegsnap-history.json") }, enabled = entries.isNotEmpty()) { Text(stringResource(R.string.export_history)) }
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
private fun HistoryPhotoStrip(id: String, model: VegsnapViewModel) {
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
private fun SettingsScreen(settings: AppSettings, model: VegsnapViewModel, onTour: () -> Unit) {
    val context = LocalContext.current
    var startMenu by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        ToggleRow(stringResource(R.string.offline), settings.offline, { enabled -> model.updateSettings { it.copy(offline = enabled) } })
        OfflineDatabaseSettings(model)
        HorizontalDivider()
        AIConnectionSettings(settings, model)
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
        ProjectLinks()
        Text(stringResource(R.string.sources), style = MaterialTheme.typography.titleLarge)
        SourceLicenseLinks()
        Spacer(Modifier.height(16.dp))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ColumnScope.AIConnectionSettings(settings: AppSettings, model: VegsnapViewModel) {
    val token by model.apiToken.collectAsStateWithLifecycle()
    val hostedToken by model.hostedToken.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val chatGPT by model.chatGPTState.collectAsStateWithLifecycle()
    val hostedAI by model.hostedAIState.collectAsStateWithLifecycle()
    val queuedJobs by model.queuedJobs.collectAsStateWithLifecycle()
    val hostedAttempts = queuedJobs.filter { it.settings.connection == "hosted" && it.status == AnalysisStatus.RUNNING }
        .map { it.id to it.attempt }
    LaunchedEffect(settings.connection, settings.offline, hostedToken, hostedAttempts) {
        // Starting/finishing attempts change allowance; stage updates do not require another request.
        if (settings.connection == "hosted" && hostedToken.isNotBlank()) model.resumeHostedAI()
    }
    var modelMenu by remember { mutableStateOf(false) }
    var accountMenu by remember { mutableStateOf(false) }
    var accountToRemove by remember { mutableStateOf<Pair<String, String>?>(null) }
    var menu by remember { mutableStateOf(false) }
    val presets = linkedMapOf("OpenAI" to "https://api.openai.com/v1", "OpenRouter" to "https://openrouter.ai/api/v1",
        "Gemini" to "https://generativelanguage.googleapis.com/v1beta/openai", "Ollama" to "http://127.0.0.1:11434/v1")
    Text(stringResource(R.string.provider), style = MaterialTheme.typography.titleLarge)
    Text(stringResource(R.string.provider_hint))
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip(settings.connection == "hosted", { model.updateSettings { it.copy(connection = "hosted") } }, label = { Text(stringResource(R.string.hosted_ai)) })
        FilterChip(settings.connection == "chatgpt", { model.updateSettings { it.copy(connection = "chatgpt") } }, label = { Text("ChatGPT") })
        FilterChip(settings.connection == "api", { model.updateSettings { it.copy(connection = "api") } }, label = { Text(stringResource(R.string.api_connection)) })
    }
    if (settings.connection == "chatgpt") {
        val accountLabels = chatGPT.savedAccounts.mapIndexed { index, account ->
            if (account.email.isBlank()) stringResource(R.string.chatgpt_unknown_account, index + 1)
            else if (chatGPT.savedAccounts.count { it.email == account.email } > 1)
                stringResource(R.string.chatgpt_account_with_email, account.email, index + 1)
            else account.email
        }
        val selectedAccountIndex = chatGPT.savedAccounts.indexOfFirst { it.clientId == chatGPT.selectedAccount }
        val selectedAccountLabel = accountLabels.getOrNull(selectedAccountIndex)
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
                TextButton(onClick = { model.connectChatGPT { url -> context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } },
                    modifier = Modifier.heightIn(min = 48.dp), enabled = !chatGPT.busy && !settings.offline) {
                    Text(stringResource(R.string.chatgpt_reconnect))
                }
                TextButton(onClick = { model.disconnectChatGPT() }, modifier = Modifier.heightIn(min = 48.dp), enabled = !settings.offline) {
                    Text(stringResource(R.string.chatgpt_disconnect))
                }
                TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://chatgpt.com/settings/usage"))) },
                    modifier = Modifier.heightIn(min = 48.dp), enabled = !settings.offline) { Text(stringResource(R.string.chatgpt_usage)) }
            }
            if (!settings.offline && settings.chatgptModel.isBlank()) {
                Text(stringResource(R.string.model_required), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
        } else {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { model.connectChatGPT { url -> context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } },
                    modifier = Modifier.heightIn(min = 48.dp), enabled = !chatGPT.busy && !settings.offline) {
                    Text(if (selectedAccountLabel == null) stringResource(R.string.chatgpt_continue)
                        else stringResource(R.string.chatgpt_reconnect_account, selectedAccountLabel))
                }
            }
            Text(stringResource(R.string.chatgpt_plan_requirement), style = MaterialTheme.typography.bodySmall)
            if (!settings.offline && !chatGPT.busy) {
                Text(stringResource(R.string.chatgpt_setup_required), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
        }
        if (chatGPT.savedAccounts.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { model.connectChatGPT(newAccount = true) { url -> context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } },
                    modifier = Modifier.heightIn(min = 48.dp), enabled = !chatGPT.busy && !settings.offline) {
                    Text(stringResource(R.string.chatgpt_another_account))
                }
                Box {
                    TextButton(onClick = { accountMenu = true }, modifier = Modifier.heightIn(min = 48.dp), enabled = !chatGPT.busy) {
                        Text(stringResource(if (chatGPT.connected) R.string.chatgpt_switch_account else R.string.chatgpt_saved_accounts))
                    }
                    DropdownMenu(accountMenu, { accountMenu = false }) { chatGPT.savedAccounts.forEachIndexed { index, account ->
                        Row(Modifier.widthIn(min = 240.dp, max = 320.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            TextButton(onClick = {
                                accountMenu = false
                                model.connectChatGPT(accountId = account.clientId) { url -> context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                            }, enabled = !chatGPT.busy && !settings.offline, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) {
                                if (chatGPT.connected && account.clientId == chatGPT.selectedAccount) {
                                    Icon(Icons.Outlined.Check, stringResource(R.string.chatgpt_connected))
                                    Spacer(Modifier.width(4.dp))
                                }
                                Text(accountLabels[index])
                            }
                            IconButton(onClick = { accountMenu = false; accountToRemove = account.clientId to accountLabels[index] },
                                enabled = !chatGPT.busy, modifier = Modifier.size(48.dp)) {
                                Icon(Icons.Outlined.Delete, stringResource(R.string.chatgpt_remove_account, accountLabels[index]))
                            }
                        }
                    } }
                }
            }
        }
        if (chatGPT.busy) {
            LinearProgressIndicator(Modifier.fillMaxWidth())
            TextButton(onClick = { model.cancelChatGPT() }, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.cancel)) }
        }
        accountToRemove?.let { (clientId, label) ->
            AlertDialog(onDismissRequest = { accountToRemove = null },
                title = { Text(stringResource(R.string.chatgpt_remove_account_title)) },
                text = { Text(stringResource(R.string.chatgpt_remove_account_message, label)) },
                confirmButton = { TextButton(onClick = { accountToRemove = null; model.removeChatGPTAccount(clientId) }, enabled = !chatGPT.busy) {
                    Text(stringResource(R.string.delete))
                } },
                dismissButton = { TextButton(onClick = { accountToRemove = null }) { Text(stringResource(R.string.cancel)) } })
        }
        chatGPT.message?.let { Text(stringResource(it), color = MaterialTheme.colorScheme.error) }
    } else if (settings.connection == "hosted") {
        Text(stringResource(R.string.hosted_ai_hint), style = MaterialTheme.typography.bodySmall)
        Text(if (hostedAI.enabled == false) stringResource(R.string.hosted_ai_unavailable)
            else if (hostedAI.state == "connected") stringResource(R.string.hosted_ai_remaining, hostedAI.remaining ?: 0)
            else stringResource(if (hostedAI.state == "pending") R.string.hosted_ai_pending else R.string.hosted_ai_refresh_hint))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (hostedAI.state != "connected") Button(onClick = { model.connectHostedAI { url -> androidx.browser.customtabs.CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(url)) } },
                modifier = Modifier.heightIn(min = 48.dp), enabled = !settings.offline && !hostedAI.busy && hostedAI.enabled != false) { Text(stringResource(R.string.hosted_ai_connect)) }
            if (hostedToken.isNotBlank()) {
                OutlinedButton(onClick = { model.refreshHostedAI() }, modifier = Modifier.heightIn(min = 48.dp), enabled = !settings.offline && !hostedAI.busy) { Text(stringResource(R.string.hosted_ai_refresh)) }
                TextButton(onClick = { model.disconnectHostedAI() }, modifier = Modifier.heightIn(min = 48.dp), enabled = !hostedAI.busy) { Text(stringResource(R.string.chatgpt_disconnect)) }
            }
        }
        if (hostedAI.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        hostedAI.message?.let { Text(stringResource(it), color = MaterialTheme.colorScheme.error) }
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
        val missingModel = !settings.offline && settings.model.isBlank()
        OutlinedTextField(settings.model, { value -> model.updateSettings { it.copy(model = value.trim()) } }, label = { Text(stringResource(R.string.model)) }, enabled = !settings.offline, singleLine = true, modifier = Modifier.fillMaxWidth(),
            isError = missingModel, supportingText = if (missingModel) ({ Text(stringResource(R.string.model_required)) }) else null)
        TextButton(onClick = { model.disconnect() }, enabled = !settings.offline) { Text(stringResource(R.string.disconnect)) }
    }
    if (settings.connection == "hosted" || (if (settings.connection == "chatgpt") settings.chatgptModel else settings.model).isNotBlank()) {
        Text(stringResource(when (modelVisionSupport(settings, chatGPT.models)) {
            true -> R.string.vision
            false -> R.string.vision_unsupported
            null -> R.string.vision_unknown
        }), style = MaterialTheme.typography.bodySmall)
    }
    if (settings.connection == "api") Text(stringResource(R.string.private_model), style = MaterialTheme.typography.bodySmall)
}

@Composable
private fun OcrLanguageSettings(model: VegsnapViewModel, offline: Boolean) {
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
private fun OcrLanguageCard(language: OcrLanguage, state: OcrLanguageState, busy: Boolean, offline: Boolean, model: VegsnapViewModel) {
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
private fun OcrDownloadProgress(language: OcrLanguage, state: OcrLanguageState, model: VegsnapViewModel) {
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
private enum class ResultDetailSection(val title: Int) {
    INGREDIENTS(R.string.result_tab_ingredients),
    SOURCES(R.string.result_tab_sources),
    CONCERNS(R.string.result_tab_concerns),
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ResultSheet(originalResult: JSONObject, onClose: () -> Unit, onRecheck: () -> Unit, onSettings: () -> Unit, model: VegsnapViewModel, failedRetry: AnalysisJob? = null) {
    val context = LocalContext.current
    val settings by model.settings.collectAsState()
    val sendToAI = canSendBarcodeToAI(originalResult)
    val locale = LocalConfiguration.current.locales[0].language.let { if (it == "de") "de" else "en" }
    val result = remember(originalResult.toString(), locale) { localizeResultTerms(context, originalResult, locale) }
    val resultId = result.getString("id")
    val scroll = remember(resultId) { LazyListState() }
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    var viewportHeight by remember(resultId) { mutableIntStateOf(0) }
    var concernHeadingHeight by remember(resultId) { mutableIntStateOf(0) }
    val concernCount = remember(result.toString()) { resultConcernCount(result) }
    val concernDescription = pluralStringResource(R.plurals.result_concern_count, concernCount, concernCount)
    val findings = result.optJSONArray("findings") ?: JSONArray()
    val evidence = result.optJSONArray("evidence") ?: JSONArray()
    val sourcesIndex = 3 + findings.length().coerceAtLeast(1)
    val concernsIndex = sourcesIndex + 1 + evidence.length().coerceAtLeast(1)
    val sectionIndices = listOf(1, sourcesIndex, concernsIndex)
    val selectedSection by remember(scroll, sourcesIndex, concernsIndex) {
        derivedStateOf {
            sectionIndices.indexOfLast { scroll.firstVisibleItemIndex >= it }.coerceAtLeast(0)
        }
    }
    // Keep a single expanded sheet and scroll container. A short final section
    // fills the remaining viewport so its heading can reach the top too.
    val concernMinHeight = with(density) { (viewportHeight - concernHeadingHeight).coerceAtLeast(0).toDp() }
        .minus(24.dp).coerceAtLeast(0.dp)
    Column(Modifier.fillMaxWidth().fillMaxHeight(.9f).testTag("result-sheet-content")) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("result-details-scroll")
            .onSizeChanged { viewportHeight = it.height }, state = scroll,
            contentPadding = PaddingValues(horizontal = 24.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
                item(key = "summary") {
                    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
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
                        if (sendToAI && settings.offline && aiStatusText != R.string.ai_status_offline) {
                            Text(stringResource(R.string.ai_status_offline), style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
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
                    }
                }
                item(key = "ingredients-heading") {
                    Text(stringResource(R.string.result_tab_ingredients),
                        Modifier.testTag("result-section-ingredients").semantics { heading() },
                        style = MaterialTheme.typography.titleMedium)
                }
                if (findings.length() == 0) item(key = "no-findings") {
                    Text(stringResource(R.string.result_no_ingredients), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                items(findings.length(), key = { "finding:$it" }) { index ->
                    val finding = findings.getJSONObject(index)
                    val original = finding.getString("term")
                    val display = finding.optString("displayTerm").ifBlank { original }
                    OutlinedCard(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                IngredientStatusIcon(finding.optString("status"))
                                Text(display, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                            }
                            Text(finding.getString("explanation"), style = MaterialTheme.typography.bodyMedium)
                            if (display != original) Text(stringResource(R.string.ingredient_original, original),
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                item(key = "ingredient-details") {
                    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        result.optJSONArray("questions")?.strings()?.takeIf { it.isNotEmpty() }?.let { questions ->
                            Text(stringResource(R.string.questions), style = MaterialTheme.typography.titleMedium)
                            questions.forEach { Text(it) }
                        }
                        result.optJSONArray("crossContact")?.strings()?.takeIf { it.isNotEmpty() }?.let { values ->
                            Text(stringResource(R.string.cross_contact), style = MaterialTheme.typography.titleMedium)
                            values.forEach { Text(it) }
                        }
                        result.optJSONArray("warnings")?.strings()?.distinct()?.forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
                        ManufacturerContactSection(result)
                        CommunityRepliesSection(result, settings.offline)
                    }
                }
                item(key = "sources-heading") {
                    Text(stringResource(R.string.result_tab_sources),
                        Modifier.testTag("result-section-sources").semantics { heading() },
                        style = MaterialTheme.typography.titleMedium)
                }
                if (evidence.length() == 0) item(key = "no-sources") {
                    Text(stringResource(R.string.result_no_sources), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                items(evidence.length(), key = { "evidence:$it" }) { index ->
                    val item = evidence.getJSONObject(index)
                    OutlinedCard(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(item.getString("title"), style = MaterialTheme.typography.titleSmall)
                            Text(item.optString("excerpt"), style = MaterialTheme.typography.bodySmall)
                            val url = item.optString("url")
                            if (url.startsWith("https://")) TextButton(onClick = {
                                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                            }) { Text(Uri.parse(url).host ?: url) }
                            Text(item.optString("retrievedAt").take(10), style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
                item(key = "concerns-heading") {
                    Text(stringResource(R.string.concerns),
                        Modifier.testTag("result-section-concerns").semantics { heading() }
                            .onSizeChanged { concernHeadingHeight = it.height },
                        style = MaterialTheme.typography.titleMedium)
                }
                item(key = "company-concerns") {
                    Column(Modifier.fillMaxWidth().heightIn(min = concernMinHeight),
                        verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        CompanyAssessmentSection(result)
                        CompanyConcernSection(result, showHeading = false)
                    }
                }
        }
        HorizontalDivider()
        SecondaryTabRow(selectedTabIndex = selectedSection) {
            ResultDetailSection.entries.forEachIndexed { index, section ->
                Tab(selected = selectedSection == index, onClick = {
                    scope.launch {
                        val reducedMotion = android.provider.Settings.Global.getFloat(
                            context.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
                        if (reducedMotion) scroll.scrollToItem(sectionIndices[index])
                        else scroll.animateScrollToItem(sectionIndices[index])
                    }
                }, modifier = Modifier.heightIn(min = 48.dp).testTag("result-nav-${section.name.lowercase()}").semantics {
                    if (section == ResultDetailSection.CONCERNS) stateDescription = concernDescription
                }) {
                    Column(Modifier.padding(horizontal = 4.dp, vertical = 12.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(when (section) {
                            ResultDetailSection.INGREDIENTS -> Icons.AutoMirrored.Outlined.ListAlt
                            ResultDetailSection.SOURCES -> Icons.Outlined.Link
                            ResultDetailSection.CONCERNS -> Icons.Outlined.WarningAmber
                        }, null, Modifier.size(20.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
                            verticalAlignment = Alignment.CenterVertically) {
                            Text(stringResource(section.title), Modifier.weight(1f, fill = false),
                                textAlign = TextAlign.Center, style = MaterialTheme.typography.labelLarge)
                            if (section == ResultDetailSection.CONCERNS && concernCount > 0) {
                                Badge(Modifier.clearAndSetSemantics { }) { Text(concernCount.toString()) }
                            }
                        }
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(modifier = Modifier.size(48.dp), onClick = {
                context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, result.getString("title") + "\n" + result.getString("summary")) }, null))
            }) {
                Icon(Icons.Outlined.Share, stringResource(R.string.copy_result))
            }
            OutlinedButton(modifier = Modifier.weight(1.15f).heightIn(min = 48.dp), contentPadding = PaddingValues(horizontal = 6.dp, vertical = 10.dp), onClick = { model.recheck(originalResult) }) {
                Icon(Icons.Outlined.EditNote, null, Modifier.size(ButtonDefaults.IconSize))
                Spacer(Modifier.width(4.dp))
                Text(stringResource(R.string.edit_result), textAlign = TextAlign.Center)
            }
            Button(modifier = Modifier.weight(1.25f).heightIn(min = 48.dp), contentPadding = PaddingValues(horizontal = 6.dp, vertical = 10.dp), onClick = onRecheck,
                enabled = !sendToAI || !settings.offline) {
                Icon(if (sendToAI) Icons.Outlined.AutoAwesome else Icons.Outlined.Refresh, null, Modifier.size(ButtonDefaults.IconSize))
                Spacer(Modifier.width(4.dp))
                Text(stringResource(if (sendToAI) R.string.barcode_send_to_ai else R.string.recheck), textAlign = TextAlign.Center)
            }
            IconButton(modifier = Modifier.size(48.dp), onClick = onClose) {
                Icon(Icons.Outlined.Close, stringResource(R.string.close))
            }
        }
    }
}

private fun startTabIcon(tab: String) = when (tab) {
    "manual" -> Icons.Outlined.EditNote
    "history" -> Icons.Outlined.History
    "last" -> Icons.Outlined.Tab
    else -> Icons.Outlined.CameraAlt
}
