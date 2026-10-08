package app.vegsnap

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.BrokenImage
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.exifinterface.media.ExifInterface
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.max

/** Bounded decoding is shared by OCR and previews, including mirrored EXIF orientations. */
internal fun loadPhotoBitmap(context: Context, uri: Uri, maxEdge: Int): Bitmap {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    context.contentResolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, bounds) }
    require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Unsupported image" }
    val options = BitmapFactory.Options().apply {
        inSampleSize = 1
        while (max(bounds.outWidth, bounds.outHeight) / inSampleSize > maxEdge) inSampleSize *= 2
    }
    val decoded = context.contentResolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, options) }
        ?: error("Cannot decode image")
    val orientation = context.contentResolver.openInputStream(uri).use { stream ->
        stream?.let { runCatching { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1) }.getOrDefault(1) } ?: 1
    }
    val matrix = Matrix().apply {
        when (orientation) {
            2 -> setScale(-1f, 1f); 3 -> setRotate(180f); 4 -> setScale(1f, -1f)
            5 -> { setRotate(90f); postScale(-1f, 1f) }; 6 -> setRotate(90f)
            7 -> { setRotate(270f); postScale(-1f, 1f) }; 8 -> setRotate(270f)
        }
    }
    val bitmap = Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
    if (bitmap !== decoded) decoded.recycle()
    return bitmap
}

@Composable
internal fun PhotoImage(uri: Uri, description: String?, modifier: Modifier = Modifier, maxEdge: Int = 384,
    contentScale: ContentScale = ContentScale.Fit, onReady: (() -> Unit)? = null) {
    val context = LocalContext.current
    val result by produceState<Result<Bitmap>?>(null, uri, maxEdge) {
        value = withContext(Dispatchers.IO) { runCatching { loadPhotoBitmap(context, uri, maxEdge) } }
    }
    val currentReady by rememberUpdatedState(onReady)
    LaunchedEffect(result) { if (result != null) currentReady?.invoke() }
    Box(modifier.background(Color.Black), contentAlignment = Alignment.Center) {
        val bitmap = result?.getOrNull()
        if (bitmap != null) Image(bitmap.asImageBitmap(), description, Modifier.matchParentSize(), contentScale = contentScale)
        else if (result == null) CircularProgressIndicator(Modifier.size(24.dp), color = Color.White, strokeWidth = 2.dp)
        else Icon(Icons.Outlined.BrokenImage, stringResource(R.string.photo_error), tint = Color.White)
    }
}
