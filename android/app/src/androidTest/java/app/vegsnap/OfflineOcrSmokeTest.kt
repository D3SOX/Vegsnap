package app.vegsnap

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import androidx.test.platform.app.InstrumentationRegistry
import java.io.ByteArrayOutputStream
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** Exercises the shipped native OCR libraries, including on 16 KB devices. */
class OfflineOcrSmokeTest {
    @Test fun bundledEnglishModelRecognizesALabelWithoutNetworkAccess() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "ocr-smoke-${System.nanoTime()}")
        val languages = OcrLanguages(root, { code -> context.assets.open("tessdata/$code.traineddata") },
            OcrModelDownload { _, _ -> error("Offline OCR must not download") }, OCR_LANGUAGES.filter { it.code == "eng" })
        val bitmap = Bitmap.createBitmap(1400, 300, Bitmap.Config.ARGB_8888)
        try {
            languages.initialize()
            val canvas = Canvas(bitmap)
            canvas.drawColor(Color.WHITE)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK; textSize = 70f }
            canvas.drawText("Ingredients: oats, milk powder", 40f, 150f, paint)
            val bytes = ByteArrayOutputStream().also { assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it)) }.toByteArray()
            val recognized = PhotoProcessor(context, languages).recognizePhoto(PreparedPhoto(bytes))
            assertTrue(recognized.text, recognized.text.lowercase().contains("milk"))
            assertTrue(recognized.text, recognized.text.lowercase().contains("oats"))
            assertFalse(recognized.truncated)
        } finally { bitmap.recycle(); root.deleteRecursively() }
    }
}
