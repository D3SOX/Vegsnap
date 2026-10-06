package app.veguide

import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class OcrLanguagesTest {
    @get:Rule val folder = TemporaryFolder()
    private val bundledBytes = "bundled test model".toByteArray()
    private val optionalBytes = "swedish test model".toByteArray()
    private fun language(code: String, bytes: ByteArray, bundled: Boolean = false) = OcrLanguage(
        code, if (code == "eng") "en" else "sv", code, bytes.size.toLong(),
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }, bundled,
    )
    private val catalog get() = listOf(language("eng", bundledBytes, true), language("swe", optionalBytes))
    private fun manager(root: File = folder.root, download: OcrModelDownload = OcrModelDownload { _, consume ->
        ByteArrayInputStream(optionalBytes).use(consume)
    }) = OcrLanguages(root, { ByteArrayInputStream(bundledBytes) }, download, catalog)
    private fun installed(code: String) = File(folder.root, "tessdata/$code.traineddata")
    private fun assertNoPartial() = assertFalse(File(folder.root, "tessdata").listFiles().orEmpty().any { it.name.endsWith(".download") })

    @Test fun `initialization is offline and installs only bundled models`() = runBlocking {
        val store = manager(download = OcrModelDownload { _, _ -> error("Unexpected network") })
        store.initialize()
        assertEquals(setOf("eng"), store.state.value.installed)
        assertEquals(setOf("eng"), store.state.value.selected)
        assertArrayEquals(bundledBytes, installed("eng").readBytes())
        assertFalse(installed("swe").exists())
    }

    @Test fun `download verifies installs and activates Swedish and persists selected OCR invocation`() = runBlocking {
        val store = manager()
        store.download("swe", offline = false)
        store.setSelected("eng", false)
        val restarted = manager(download = OcrModelDownload { _, _ -> error("Offline OCR should not download") })
        restarted.initialize()
        assertEquals(setOf("swe"), restarted.state.value.selected)
        restarted.withModels { root, languages ->
            assertEquals(folder.root, root)
            assertEquals("swe", languages)
            assertArrayEquals(optionalBytes, File(root, "tessdata/swe.traineddata").readBytes())
        }
    }

    @Test fun `offline download makes no network request or optional installation`() = runBlocking {
        val store = manager(download = OcrModelDownload { _, _ -> error("Unexpected network") })
        assertThrows(IllegalArgumentException::class.java) { runBlocking { store.download("swe", true) } }
        assertFalse(installed("swe").exists())
    }

    @Test fun `wrong hash cannot become installed or selected`() = runBlocking {
        val corrupt = optionalBytes.copyOf().apply { this[0] = 0 }
        val store = manager(download = OcrModelDownload { _, consume -> ByteArrayInputStream(corrupt).use(consume) })
        assertThrows(IllegalArgumentException::class.java) { runBlocking { store.download("swe", false) } }
        assertEquals(setOf("eng"), store.state.value.installed)
        assertEquals(setOf("eng"), store.state.value.selected)
        assertFalse(installed("swe").exists())
        assertNull(store.state.value.downloading)
        assertNoPartial()
    }

    @Test fun `truncated and oversized responses leave no files`() = runBlocking {
        for (bytes in listOf(optionalBytes.dropLast(1).toByteArray(), optionalBytes + byteArrayOf(0))) {
            val store = manager(download = OcrModelDownload { _, consume -> ByteArrayInputStream(bytes).use(consume) })
            assertThrows(IllegalArgumentException::class.java) { runBlocking { store.download("swe", false) } }
            assertFalse(installed("swe").exists())
            assertNoPartial()
        }
    }

    @Test fun `cancellation after partial write cleans up and leaves previous selection usable`() = runBlocking {
        val store = manager(download = OcrModelDownload { _, consume ->
            val job = currentCoroutineContext().job
            val source = object : InputStream() {
                override fun read(): Int = error("Bulk reads expected")
                override fun read(bytes: ByteArray, offset: Int, count: Int): Int {
                    bytes[offset] = optionalBytes[0]
                    job.cancel()
                    return 1
                }
            }
            source.use(consume)
        })
        launch { store.download("swe", false) }.join()
        assertEquals(setOf("eng"), store.state.value.selected)
        assertFalse(installed("swe").exists())
        assertNull(store.state.value.downloading)
        assertNoPartial()
        store.withModels { _, languages -> assertEquals("eng", languages) }
    }

    @Test fun `shared manager can cancel a transfer started by another caller`() = runBlocking {
        val started = CompletableDeferred<Unit>()
        val store = manager(download = OcrModelDownload { _, _ ->
            started.complete(Unit)
            awaitCancellation()
        })
        val operation = launch { store.download("swe", false) }
        started.await()
        store.cancelAndJoinDownload()
        operation.join()
        assertNull(store.state.value.downloading)
        assertEquals(setOf("eng"), store.state.value.selected)
        assertFalse(installed("swe").exists())
        assertNoPartial()
    }

    @Test fun `language removal cannot delete bundled files or the final active language`() = runBlocking {
        val store = manager()
        store.download("swe", false)
        assertThrows(IllegalArgumentException::class.java) { runBlocking { store.remove("eng") } }
        store.setSelected("eng", false)
        assertThrows(IllegalArgumentException::class.java) { runBlocking { store.setSelected("swe", false) } }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { store.remove("swe") } }
        assertTrue(installed("swe").exists())
        store.setSelected("eng", true)
        store.remove("swe")
        assertFalse(installed("swe").exists())
        val restarted = manager()
        restarted.initialize()
        assertEquals(setOf("eng"), restarted.state.value.selected)
    }

    @Test fun `failed selection save cannot remove a selected model`() = runBlocking {
        val store = manager()
        store.download("swe", false)
        val selection = File(folder.root, "selected-languages")
        assertTrue(selection.delete())
        assertTrue(selection.mkdir())
        File(selection, "block-rename").writeText("test")
        assertThrows(IllegalStateException::class.java) { runBlocking { store.remove("swe") } }
        assertTrue(installed("swe").exists())
        assertEquals(setOf("eng", "swe"), store.state.value.selected)
        store.withModels { _, languages -> assertEquals("eng+swe", languages) }
    }

    @Test fun `uninstalled language cannot be selected`() = runBlocking {
        val store = manager()
        assertThrows(IllegalArgumentException::class.java) { runBlocking { store.setSelected("swe", true) } }
        assertEquals(setOf("eng"), store.state.value.selected)
    }

    @Test fun `partial and corrupt models from a previous process are excluded`() = runBlocking {
        val target = installed("swe")
        target.parentFile!!.mkdirs()
        target.writeBytes(optionalBytes.copyOf().apply { this[0] = 0 })
        File(target.parentFile, "swe.download").writeBytes(optionalBytes)
        File(folder.root, "selected-languages").writeText("swe\n../../untrusted")
        val store = manager()
        store.initialize()
        assertFalse(target.exists())
        assertNoPartial()
        assertEquals(setOf("eng"), store.state.value.selected)
    }

    @Test fun `removal waits for native OCR to release model files`() = runBlocking {
        val store = manager()
        store.download("swe", false)
        val reading = CountDownLatch(1)
        val release = CountDownLatch(1)
        val reader = launch(Dispatchers.IO) {
            store.withModels { _, languages ->
                assertEquals("eng+swe", languages)
                reading.countDown()
                assertTrue(release.await(5, TimeUnit.SECONDS))
                assertTrue(installed("swe").exists())
            }
        }
        assertTrue(withContext(Dispatchers.IO) { reading.await(5, TimeUnit.SECONDS) })
        val removal = async { store.remove("swe") }
        yield()
        assertFalse(removal.isCompleted)
        assertTrue(installed("swe").exists())
        release.countDown()
        reader.join()
        removal.await()
        assertFalse(installed("swe").exists())
    }

    @Test fun `catalog uses fixed official URLs with valid integrity and size metadata`() {
        assertEquals(OCR_LANGUAGES.size, OCR_LANGUAGES.map { it.code }.toSet().size)
        assertEquals(setOf("eng", "deu"), OCR_LANGUAGES.filter { it.bundled }.map { it.code }.toSet())
        assertTrue(OCR_LANGUAGES.any { it.code == "swe" && !it.bundled })
        for (language in OCR_LANGUAGES) {
            assertTrue(language.sha256.matches(Regex("[a-f0-9]{64}")))
            assertTrue(language.bytes in 1..10_000_000)
            assertEquals("https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/$OCR_MODEL_REVISION/${language.code}.traineddata", language.url)
        }
    }
}
