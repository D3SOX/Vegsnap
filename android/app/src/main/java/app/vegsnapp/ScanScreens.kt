package app.vegsnapp

import android.Manifest
import android.animation.ValueAnimator
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.util.Rational
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.*
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch

@Composable
internal fun ScanScreen(state: ScanState, model: VegsnapViewModel) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val settings by model.settings.collectAsStateWithLifecycle()
    var resumed by remember { mutableStateOf(lifecycle.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    var permission by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) { resumed = true; permission = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED }
            if (event == Lifecycle.Event.ON_PAUSE || event == Lifecycle.Event.ON_STOP) { resumed = false; model.cameraBarcodeScanning(false) }
        }
        lifecycle.lifecycle.addObserver(observer)
        onDispose { lifecycle.lifecycle.removeObserver(observer); model.cameraBarcodeScanning(false) }
    }
    val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { permission = it }
    var gallery by remember { mutableStateOf<Uri?>(null) }
    var flyingPhoto by remember { mutableStateOf<Uri?>(null) }
    val barcodeActive = permission && resumed && state.result == null && state.focusedJob == null && !state.busy && !state.capturing && state.photos.isEmpty() && gallery == null
    LaunchedEffect(barcodeActive, settings.offline) { model.cameraBarcodeScanning(barcodeActive) }
    val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    val aspect = if (landscape) 4f / 3f else 3f / 4f
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        if (permission && state.result == null) CameraView(
            enabled = !state.busy && !state.capturing && state.photos.size < 3 && flyingPhoto == null,
            aspect = aspect, barcodeEnabled = barcodeActive, onBarcode = model::detectCameraBarcode,
            onCaptureStarted = { model.update { it.copy(capturing = true, photoBarcode = if (it.photos.isEmpty()) it.cameraBarcode else it.photoBarcode) } },
            onPhoto = { uri ->
                model.update { it.copy(capturing = false) }
                model.addPhotos(listOf(uri))
                if (ValueAnimator.areAnimatorsEnabled()) flyingPhoto = uri
            },
            onError = { model.update { it.copy(capturing = false, message = R.string.photo_error) } }
        ) else if (!permission) ElevatedCard(Modifier.align(Alignment.Center).padding(24.dp)) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(R.string.camera_denied))
                Button(onClick = { request.launch(Manifest.permission.CAMERA) }) { Text(stringResource(R.string.camera_permission)) }
                TextButton(onClick = { model.selectTab("manual") }) { Text(stringResource(R.string.manual)) }
            }
        }
        CategorySelector(state.category, !state.busy && !state.capturing, { value -> model.update { it.copy(category = value) } },
            Modifier.align(Alignment.TopStart).padding(16.dp))
        if (state.cameraBarcode.isNotBlank()) Surface(Modifier.align(Alignment.TopEnd).padding(top = 76.dp, start = 16.dp, end = 16.dp).widthIn(max = 300.dp), shape = RoundedCornerShape(16.dp)) {
            Row(Modifier.padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(state.cameraBarcode, style = MaterialTheme.typography.labelLarge)
                    Text(stringResource(if (state.barcodeLookingUp) R.string.barcode_database_loading else if (settings.offline) R.string.barcode_offline_saved else R.string.barcode_saved_for_check), style = MaterialTheme.typography.bodySmall)
                }
                if (state.barcodeLookingUp) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                IconButton(onClick = model::clearCameraBarcode) { Icon(Icons.Outlined.Close, stringResource(R.string.barcode_clear)) }
            }
        }
        if (state.busy) CheckProgressCard(state, model::cancel,
            Modifier.align(Alignment.Center).padding(24.dp).widthIn(max = 360.dp).fillMaxWidth())
        Box(Modifier.align(Alignment.BottomStart).padding(start = 20.dp, bottom = 28.dp).size(72.dp), contentAlignment = Alignment.Center) {
            if (state.photos.isNotEmpty()) PhotoStack(state.photos,
                enabled = !state.busy && !state.capturing && flyingPhoto == null,
                onClick = { gallery = state.photos.last() })
            else Icon(Icons.Outlined.PhotoLibrary, stringResource(R.string.no_photos), tint = Color.White.copy(alpha = 0.7f), modifier = Modifier.size(28.dp))
        }
        FilledTonalIconButton(onClick = model::checkPhotos,
            enabled = state.photos.isNotEmpty() && !state.busy && !state.capturing && flyingPhoto == null,
            modifier = Modifier.align(Alignment.BottomEnd).padding(end = 24.dp, bottom = 32.dp).size(64.dp)) {
            Icon(Icons.Outlined.Search, stringResource(R.string.check), Modifier.size(28.dp))
        }
        if (state.photos.size == 3 && !state.busy && state.cameraBarcode.isBlank()) Surface(Modifier.align(Alignment.TopEnd).padding(top = 76.dp, end = 16.dp), shape = RoundedCornerShape(12.dp)) {
            Text(stringResource(R.string.photo_limit), Modifier.padding(12.dp), style = MaterialTheme.typography.labelMedium)
        }
        flyingPhoto?.let { uri -> CaptureFlight(uri, aspect) { flyingPhoto = null } }
    }
    gallery?.let { uri -> PhotoGallery(state.photos, uri, !state.busy && !state.capturing, model::removePhoto) { gallery = null } }
}

@Composable
private fun CameraView(enabled: Boolean, aspect: Float, barcodeEnabled: Boolean, onBarcode: (String) -> Unit, onCaptureStarted: () -> Unit,
    onPhoto: (Uri) -> Unit, onError: () -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val currentPhoto by rememberUpdatedState(onPhoto)
    val currentError by rememberUpdatedState(onError)
    val currentBarcode by rememberUpdatedState(onBarcode)
    val currentBarcodeEnabled by rememberUpdatedState(barcodeEnabled)
    val preview = remember { PreviewView(context).apply {
        scaleType = PreviewView.ScaleType.FIT_CENTER
        implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    } }
    val selector = remember { ResolutionSelector.Builder().setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY).build() }
    val capture = remember { ImageCapture.Builder().setResolutionSelector(selector).setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY).build() }
    var ready by remember { mutableStateOf(false) }
    var taking by remember { mutableStateOf(false) }
    DisposableEffect(lifecycle, aspect) {
        val disposed = java.util.concurrent.atomic.AtomicBoolean(false)
        var provider: ProcessCameraProvider? = null
        var useCase: Preview? = null
        val executor = java.util.concurrent.Executors.newSingleThreadExecutor()
        val decoder = RetailBarcodeDecoder()
        val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .setResolutionSelector(ResolutionSelector.Builder().setResolutionStrategy(ResolutionStrategy(android.util.Size(1280, 960), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER)).build()).build()
        val mainExecutor = ContextCompat.getMainExecutor(context)
        var lastFrame = 0L
        analysis.setAnalyzer(executor) { image ->
            try {
                val now = android.os.SystemClock.elapsedRealtime()
                if (!disposed.get() && currentBarcodeEnabled && now - lastFrame >= 500) {
                    lastFrame = now
                    val crop = image.cropRect
                    val plane = image.planes.firstOrNull()
                    if (plane != null) {
                        val bytes = copyLuminance(plane.buffer, crop.width(), crop.height(), plane.rowStride, plane.pixelStride, crop.left, crop.top)
                        decoder.decode(bytes, crop.width(), crop.height())?.let { barcode ->
                            mainExecutor.execute { if (!disposed.get() && currentBarcodeEnabled) currentBarcode(barcode) }
                        }
                    }
                }
            } catch (_: Exception) { /* An unreadable frame must not stop preview/capture. */ }
            finally { image.close() }
        }
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            if (!disposed.get()) runCatching {
                provider = future.get()
                val rotation = preview.display?.rotation ?: android.view.Surface.ROTATION_0
                capture.targetRotation = rotation
                analysis.targetRotation = rotation
                useCase = Preview.Builder().setResolutionSelector(selector).setTargetRotation(rotation).build().also { it.surfaceProvider = preview.surfaceProvider }
                // Same sensor region across camera outputs; FIT_CENTER shows that whole region instead of filling/cropping the screen.
                val viewport = ViewPort.Builder(if (aspect < 1) Rational(3, 4) else Rational(4, 3), rotation)
                    .setScaleType(ViewPort.FILL_CENTER).build()
                provider?.bindToLifecycle(lifecycle, CameraSelector.DEFAULT_BACK_CAMERA,
                    UseCaseGroup.Builder().setViewPort(viewport).addUseCase(useCase!!).addUseCase(capture).addUseCase(analysis).build())
                ready = true
            }.onFailure { currentError() }
        }, ContextCompat.getMainExecutor(context))
        onDispose { disposed.set(true); analysis.clearAnalyzer(); useCase?.let { provider?.unbind(it, capture, analysis) }; executor.shutdown(); ready = false }
    }
    Box(Modifier.fillMaxSize()) {
        AndroidView(factory = { preview }, modifier = Modifier.fillMaxSize())
        FilledIconButton(onClick = {
            taking = true
            onCaptureStarted()
            val file = runCatching { CaptureFiles.get(context).create() }.getOrElse {
                taking = false; currentError(); return@FilledIconButton
            }
            capture.takePicture(ImageCapture.OutputFileOptions.Builder(file).build(), ContextCompat.getMainExecutor(context), object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) { taking = false; currentPhoto(Uri.fromFile(file)) }
                override fun onError(exception: ImageCaptureException) { taking = false; file.delete(); currentError() }
            })
        }, enabled = ready && enabled && !taking,
            colors = IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.primaryContainer,
                contentColor = MaterialTheme.colorScheme.onPrimaryContainer),
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 24.dp).size(80.dp)) {
            if (taking) CircularProgressIndicator(Modifier.size(32.dp), color = MaterialTheme.colorScheme.onPrimaryContainer, strokeWidth = 3.dp)
            else Icon(Icons.Outlined.CameraAlt, stringResource(R.string.take_photo), Modifier.size(32.dp))
        }
    }
}

@Composable
private fun CaptureFlight(uri: Uri, aspect: Float, onComplete: () -> Unit) {
    val progress = remember(uri) { Animatable(0f) }
    val currentComplete by rememberUpdatedState(onComplete)
    var imageReady by remember(uri) { mutableStateOf(false) }
    LaunchedEffect(uri, imageReady) {
        if (!imageReady) return@LaunchedEffect
        // Compose's duration scale follows Android's reduced/disabled animation setting.
        progress.animateTo(1f, tween(480, easing = FastOutSlowInEasing))
        currentComplete()
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val density = LocalDensity.current
        val bounds = fittedPhoto(maxWidth.value, maxHeight.value, aspect)
        val targetScale = 64f / maxOf(bounds.width, bounds.height)
        val destinationX = 20f + (64f - bounds.width * targetScale) / 2f
        val destinationY = maxHeight.value - 100f + (64f - bounds.height * targetScale) / 2f
        PhotoImage(uri, null, Modifier.offset(bounds.left.dp, bounds.top.dp).size(bounds.width.dp, bounds.height.dp)
            .graphicsLayer {
                val value = progress.value
                transformOrigin = TransformOrigin(0f, 0f)
                scaleX = 1f + (targetScale - 1f) * value
                scaleY = scaleX
                translationX = with(density) { ((destinationX - bounds.left) * value).dp.toPx() }
                translationY = with(density) { ((destinationY - bounds.top) * value).dp.toPx() }
                rotationZ = -4f * value
            }.clip(RoundedCornerShape(12.dp)), maxEdge = 1024, onReady = { imageReady = true })
    }
}

@Composable
private fun PhotoStack(photos: List<Uri>, enabled: Boolean, onClick: () -> Unit) {
    val description = stringResource(R.string.preview_photos, photos.size)
    Box(Modifier.size(72.dp).clip(RoundedCornerShape(12.dp)).clickable(enabled = enabled, onClickLabel = description, onClick = onClick)
        .semantics { contentDescription = description }) {
        photos.takeLast(3).forEachIndexed { index, uri ->
            PhotoImage(uri, null, Modifier.size(64.dp).graphicsLayer {
                rotationZ = (index - photos.takeLast(3).lastIndex) * 6f - 4f
                translationX = index * 2.dp.toPx()
            }.clip(RoundedCornerShape(10.dp)).border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(10.dp)))
        }
        Surface(Modifier.align(Alignment.BottomEnd), shape = CircleShape, color = MaterialTheme.colorScheme.primary) {
            Text(photos.size.toString(), Modifier.padding(horizontal = 7.dp, vertical = 2.dp), style = MaterialTheme.typography.labelSmall)
        }
    }
}

@Composable
internal fun ManualScreen(state: ScanState, model: VegsnapViewModel) {
    val keyboard = LocalSoftwareKeyboardController.current
    val ocr by model.ocrState.collectAsStateWithLifecycle()
    val import = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(3)) { model.addPhotos(it) }
    var preview by remember { mutableStateOf<Uri?>(null) }
    val enabled = !state.busy && !state.capturing
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(stringResource(R.string.manual_hint))
            CategorySelector(state.category, enabled, { value -> model.update { it.copy(category = value) } })
            OutlinedTextField(value = state.name, onValueChange = { value -> model.update { it.copy(name = value.take(300)) } },
                label = { Text(stringResource(R.string.product_name)) }, modifier = Modifier.fillMaxWidth(), singleLine = true, enabled = enabled)
            if (state.barcode.isNotBlank()) OutlinedTextField(value = state.barcode, onValueChange = { value -> model.update { it.copy(barcode = value.take(14)) } },
                label = { Text(stringResource(R.string.barcode)) }, modifier = Modifier.fillMaxWidth(), singleLine = true, enabled = enabled)
            OutlinedTextField(value = state.text, onValueChange = { value -> model.update { it.withText(value) } },
                label = { Text(stringResource(R.string.text_label)) }, modifier = Modifier.fillMaxWidth(), minLines = 3, maxLines = 7, enabled = enabled)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { import.launch(androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                    enabled = enabled && state.photos.size < 3, modifier = Modifier.weight(1f)) {
                    Icon(Icons.Outlined.PhotoLibrary, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.import_photo))
                }
                OutlinedButton(onClick = { keyboard?.hide(); model.selectTab("scan") }, enabled = enabled && state.photos.size < 3,
                    modifier = Modifier.weight(1f)) {
                    Icon(Icons.Outlined.CameraAlt, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.take_photo))
                }
            }
            if (state.photos.isNotEmpty()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.photos, state.photos.size), Modifier.weight(1f))
                    TextButton(onClick = model::clearPhotos, enabled = enabled) { Text(stringResource(R.string.clear_photos)) }
                }
                SelectedPhotos(state.photos, enabled, { preview = it }, model::removePhoto)
                Text(stringResource(R.string.on_device, OCR_LANGUAGES.filter { it.code in ocr.selected }.joinToString(" + ") { it.tag.uppercase(java.util.Locale.ROOT) }), style = MaterialTheme.typography.labelMedium)
            }
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(
                value = state.complete, enabled = enabled, role = Role.Checkbox,
                onValueChange = { value -> model.update { it.copy(complete = value) } },
            ).padding(horizontal = 12.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Checkbox(state.complete, onCheckedChange = null, enabled = enabled, modifier = Modifier.size(24.dp))
                Text(stringResource(R.string.complete), Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
            }
            Button(onClick = { keyboard?.hide(); model.check() }, enabled = enabled && (state.text.isNotBlank() || state.name.isNotBlank() || state.barcode.isNotBlank() || state.photos.isNotEmpty()), modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                Icon(Icons.Outlined.Search, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.check))
            }
        }
        if (state.busy) CheckProgressCard(state, model::cancel,
            Modifier.align(Alignment.Center).padding(24.dp).widthIn(max = 360.dp).fillMaxWidth())
    }
    preview?.let { PhotoGallery(state.photos, it, enabled, model::removePhoto) { preview = null } }
}

@Composable
private fun CheckProgressCard(state: ScanState, onCancel: () -> Unit, modifier: Modifier = Modifier) {
    val startedAt = state.checkStartedAt
    val elapsedSeconds by produceState(initialValue = 0L, key1 = startedAt) {
        while (startedAt != null) {
            value = ((android.os.SystemClock.elapsedRealtime() - startedAt) / 1000).coerceAtLeast(0)
            kotlinx.coroutines.delay(1000)
        }
    }
    Surface(modifier, shape = RoundedCornerShape(20.dp), tonalElevation = 6.dp, shadowElevation = 6.dp) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(stringResource((state.checkStage ?: CheckStage.PREPARING).label),
                Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.titleMedium)
            LinearProgressIndicator(Modifier.fillMaxWidth())
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                Text(stringResource(R.string.progress_elapsed, elapsedSeconds / 60, elapsedSeconds % 60),
                    Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton(onClick = onCancel, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.cancel)) }
            }
        }
    }
}

@Composable
private fun CategorySelector(category: String, enabled: Boolean, onSelect: (String) -> Unit, modifier: Modifier = Modifier) {
    var expanded by remember { mutableStateOf(false) }
    Box(modifier) {
        FilledTonalButton(onClick = { expanded = true }, enabled = enabled) {
            Icon(categoryIcon(category), null, Modifier.size(20.dp))
            Spacer(Modifier.width(8.dp))
            Text(stringResource(categories[category] ?: R.string.auto_category))
            Icon(Icons.Outlined.ArrowDropDown, stringResource(R.string.category))
        }
        DropdownMenu(expanded, { expanded = false }) { categories.forEach { (key, title) ->
            DropdownMenuItem(text = { Text(stringResource(title)) }, leadingIcon = { Icon(categoryIcon(key), null) },
                onClick = { onSelect(key); expanded = false })
        } }
    }
}

@Composable
private fun SelectedPhotos(photos: List<Uri>, enabled: Boolean, onOpen: (Uri) -> Unit, onRemove: (Uri) -> Unit) {
    LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        itemsIndexed(photos, key = { _, uri -> uri.toString() }) { index, uri ->
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                PhotoImage(uri, stringResource(R.string.photo_number, index + 1), Modifier.size(96.dp).clip(RoundedCornerShape(12.dp))
                    .clickable(enabled = enabled, onClick = { onOpen(uri) }))
                IconButton(onClick = { onRemove(uri) }, enabled = enabled) { Icon(Icons.Outlined.Close, stringResource(R.string.remove_photo, index + 1)) }
            }
        }
    }
}

@Composable
internal fun PhotoGallery(photos: List<Uri>, initial: Uri, enabled: Boolean, onRemove: ((Uri) -> Unit)?, onClose: () -> Unit) {
    if (photos.isEmpty()) { LaunchedEffect(Unit) { onClose() }; return }
    val pager = rememberPagerState(initialPage = photos.indexOf(initial).coerceAtLeast(0), pageCount = { photos.size })
    val scope = rememberCoroutineScope()
    val close by rememberUpdatedState(onClose)
    val dismissThreshold = with(LocalDensity.current) { 96.dp.toPx() }
    var dragDistance by remember { mutableFloatStateOf(0f) }
    var dragging by remember { mutableStateOf(false) }
    val dragOffset by animateFloatAsState(dragDistance, animationSpec = if (dragging) snap() else spring(), label = "photo-dismiss")
    val index = pager.currentPage.coerceIn(photos.indices)
    val current = photos[index]
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().safeDrawingPadding().graphicsLayer { translationY = dragOffset }) {
                HorizontalPager(state = pager, key = { photos[it].toString() },
                    modifier = Modifier.fillMaxWidth().weight(1f).testTag("photo-pager")
                        .pointerInput(dismissThreshold) {
                            detectVerticalDragGestures(
                                onDragStart = { dragDistance = dragOffset; dragging = true },
                                onDragCancel = { dragging = false; dragDistance = 0f },
                                onDragEnd = {
                                    dragging = false
                                    if (dragDistance >= dismissThreshold) close() else dragDistance = 0f
                                },
                                onVerticalDrag = { change, amount ->
                                    change.consume()
                                    dragDistance = (dragDistance + amount).coerceAtLeast(0f)
                                },
                            )
                        }) { page ->
                    PhotoImage(photos[page], stringResource(R.string.photo_number, page + 1), Modifier.fillMaxSize(), maxEdge = 1600)
                }
                Surface(modifier = Modifier.align(Alignment.CenterHorizontally).padding(12.dp).widthIn(max = 480.dp).fillMaxWidth(),
                    shape = RoundedCornerShape(28.dp), color = MaterialTheme.colorScheme.surfaceContainer, tonalElevation = 3.dp) {
                    Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        FilledTonalIconButton(onClick = onClose) { Icon(Icons.Outlined.Close, stringResource(R.string.close)) }
                        IconButton(onClick = { scope.launch { pager.animateScrollToPage((index - 1).coerceAtLeast(0)) } },
                            enabled = index > 0 && !pager.isScrollInProgress) { Icon(Icons.Outlined.ChevronLeft, stringResource(R.string.previous_photo)) }
                        Text(stringResource(R.string.photo_position, index + 1, photos.size),
                            Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.labelLarge,
                            textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                        IconButton(onClick = { scope.launch { pager.animateScrollToPage((index + 1).coerceAtMost(photos.lastIndex)) } },
                            enabled = index < photos.lastIndex && !pager.isScrollInProgress) { Icon(Icons.Outlined.ChevronRight, stringResource(R.string.next_photo)) }
                        if (onRemove != null) FilledTonalIconButton(onClick = { onRemove(current) }, enabled = enabled && !pager.isScrollInProgress,
                            colors = IconButtonDefaults.filledTonalIconButtonColors(containerColor = MaterialTheme.colorScheme.errorContainer,
                                contentColor = MaterialTheme.colorScheme.onErrorContainer)) {
                            Icon(Icons.Outlined.Delete, stringResource(R.string.remove_photo, index + 1))
                        }
                    }
                }
            }
        }
    }
}
