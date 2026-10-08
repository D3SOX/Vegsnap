package app.vegsnap

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import com.googlecode.tesseract.android.TessBaseAPI
import java.io.ByteArrayOutputStream
import kotlin.math.max

data class PreparedPhoto(val jpeg: ByteArray, val text: String = "", val truncated: Boolean = false)
class PhotoProcessor(private val context: Context, private val languages: OcrLanguages) {
    /** Decode with a sample bound, orient correctly, then encode fresh pixels only. */
    suspend fun prepare(uri: Uri): PreparedPhoto {
        var bitmap = loadPhotoBitmap(context, uri, 2400)
        val scale = minOf(1f, 1600f / max(bitmap.width, bitmap.height))
        if (scale < 1f) {
            val small = Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).toInt(), (bitmap.height * scale).toInt(), true)
            if (small !== bitmap) bitmap.recycle()
            bitmap = small
        }
        try {
            val output = ByteArrayOutputStream()
            check(bitmap.compress(Bitmap.CompressFormat.JPEG, 88, output))
            return PreparedPhoto(output.toByteArray())
        } finally { bitmap.recycle() }
    }
    /** Lazy fallback: recognize the already sanitized JPEG, without re-encoding the image. */
    suspend fun recognizePhoto(photo: PreparedPhoto): PreparedPhoto {
        val bitmap = requireNotNull(BitmapFactory.decodeByteArray(photo.jpeg, 0, photo.jpeg.size))
        return try {
            val text = recognize(bitmap)
            photo.copy(text = text.text, truncated = text.truncated)
        } finally { bitmap.recycle() }
    }
    private suspend fun recognize(bitmap: Bitmap): BoundedProductText = languages.withModels { root, selected ->
        val tess = TessBaseAPI()
        try {
            check(tess.init(root.absolutePath, selected))
            tess.setImage(bitmap)
            boundedProductText(tess.utF8Text.orEmpty(), 20_000)
        } finally { tess.recycle() }
    }
}
