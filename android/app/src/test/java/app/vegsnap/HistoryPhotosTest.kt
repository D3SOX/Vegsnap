package app.vegsnap

import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class HistoryPhotosTest {
    private fun withStore(test: suspend (File, HistoryPhotoStore) -> Unit) = runBlocking {
        val root = Files.createTempDirectory("vegsnap-history").toFile()
        try { test(root, HistoryPhotoStore(File(root, "history-photos"))) }
        finally { root.deleteRecursively() }
    }

    @Test fun `draft persists without photos and is deleted with its history entry`() = withStore { _, store ->
        val input = CheckInput("water, salt", "food", true, "Product")
        store.save("manual", emptyList(), input) { }
        assertEquals(input, store.input("manual"))
        assertTrue(store.files("manual").isEmpty())
        store.delete("manual") { }
        assertNull(store.input("manual"))
        try { store.save("failed", emptyList(), input) { error("database failed") }; fail("must throw") }
        catch (_: IllegalStateException) { }
        assertNull(store.input("failed"))
    }

    @Test fun `successful save retains analyzed copies after camera input is cleared`() = withStore { root, store ->
        val cache = File(root, "cache").apply { mkdirs() }
        val captures = CaptureFileStore(cache)
        val capture = captures.create().apply { writeText("original camera pixels") }
        val galleryOriginal = File(root, "gallery.jpg").apply { writeText("user gallery original") }
        val otherCache = File(cache, "other.jpg").apply { writeText("unrelated") }
        var historySaved = false
        store.save("result", listOf("sanitized JPEG".toByteArray())) {
            assertEquals("sanitized JPEG", store.files("result").single().readText())
            historySaved = true
        }
        captures.deleteOwned(capture)
        captures.deleteOwned(galleryOriginal)
        captures.deleteOwned(otherCache)
        assertTrue(historySaved)
        assertFalse(capture.exists())
        assertEquals("sanitized JPEG", store.files("result").single().readText())
        assertTrue(galleryOriginal.exists())
        assertTrue(otherCache.exists())
    }

    @Test fun `failed and cancelled history writes roll back copies and retain camera input`() = withStore { root, store ->
        val cache = File(root, "cache").apply { mkdirs() }
        val capture = CaptureFileStore(cache).create().apply { writeText("retry") }
        for (failure in listOf(IllegalStateException("database failed"), CancellationException("cancelled"))) {
            try { store.save("result", listOf(byteArrayOf(1, 2, 3))) { throw failure }; fail("must throw") }
            catch (error: Exception) { assertSame(failure, error) }
            assertTrue(store.files("result").isEmpty())
            assertEquals("retry", capture.readText())
        }
    }

    @Test fun `partial photo write never creates a history record`() = withStore { _, store ->
        var saved = false
        try { store.save("partial", listOf(byteArrayOf(1), byteArrayOf())) { saved = true }; fail("must throw") }
        catch (_: IllegalArgumentException) { }
        assertFalse(saved)
        assertTrue(store.files("partial").isEmpty())
    }

    @Test fun `individual deletion leaves other records and gallery originals intact`() = withStore { root, store ->
        val gallery = File(root, "photo.jpg").apply { writeText("original") }
        store.save("one", listOf(byteArrayOf(1))) { }
        store.save("two", listOf(byteArrayOf(2))) { }
        store.delete("one") { }
        assertTrue(store.files("one").isEmpty())
        assertArrayEquals(byteArrayOf(2), store.files("two").single().readBytes())
        store.clear { }
        assertTrue(store.files("two").isEmpty())
        assertTrue(gallery.exists())
    }

    @Test fun `failed delete keeps photos and startup prunes only unreferenced records`() = withStore { _, store ->
        store.save("keep", listOf(byteArrayOf(1))) { }
        store.save("orphan", listOf(byteArrayOf(2))) { }
        try { store.delete("keep") { error("database failed") }; fail("must throw") }
        catch (_: IllegalStateException) { }
        assertEquals(1, store.files("keep").size)
        store.prune { listOf("keep") }
        assertEquals(1, store.files("keep").size)
        assertTrue(store.files("orphan").isEmpty())
    }

    @Test fun `import replaces matching photo evidence but does not touch another record`() = withStore { _, store ->
        store.save("matching", listOf(byteArrayOf(1))) { }
        store.save("other", listOf(byteArrayOf(2))) { }
        store.importResults(listOf("matching")) { }
        assertTrue(store.files("matching").isEmpty())
        assertEquals(1, store.files("other").size)
    }

    @Test fun `imported identifiers cannot escape the app history directory`() = withStore { root, store ->
        val outside = File(root, "photo.jpg").apply { writeText("keep") }
        store.save("../../photo.jpg", listOf(byteArrayOf(1))) { }
        assertEquals("history-photos", store.files("../../photo.jpg").single().parentFile?.parentFile?.name)
        store.delete("../../photo.jpg") { }
        assertEquals("keep", outside.readText())
    }
}
