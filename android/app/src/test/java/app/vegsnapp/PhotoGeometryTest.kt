package app.vegsnapp

import org.junit.Assert.*
import org.junit.Test

class PhotoGeometryTest {
    @Test fun `portrait preview keeps complete four by three frame`() {
        val photo = fittedPhoto(400f, 800f, 3f / 4f)
        assertEquals(0f, photo.left, 0.001f)
        assertEquals(400f, photo.width, 0.001f)
        assertEquals(400f / (3f / 4f), photo.height, 0.001f)
        assertEquals((800f - photo.height) / 2f, photo.top, 0.001f)
    }
    @Test fun `landscape preview keeps complete four by three frame`() {
        val photo = fittedPhoto(800f, 400f, 4f / 3f)
        assertEquals(0f, photo.top, 0.001f)
        assertEquals(400f, photo.height, 0.001f)
        assertEquals(400f * 4f / 3f, photo.width, 0.001f)
        assertEquals((800f - photo.width) / 2f, photo.left, 0.001f)
    }
    @Test fun `opening a second activity cannot remove captures from the active process`() {
        val directory = java.nio.file.Files.createTempDirectory("vegsnap-captures").toFile()
        try {
            val stale = java.io.File(directory, "scan-old.jpg").apply { writeText("old process") }
            val unrelated = java.io.File(directory, "other.jpg").apply { writeText("keep") }
            val files = CaptureFileStore(directory)
            val active = files.create().apply { writeText("active capture") }
            files.clearPreviousProcess()
            assertFalse(stale.exists())
            assertTrue(active.exists())
            assertTrue(unrelated.exists())
        } finally { directory.deleteRecursively() }
    }
    @Test fun `scan does not secretly include text or completeness entered on manual tab`() {
        val manual = ScanState(text = "Milk", category = "cosmetics", complete = true, textTruncated = true)
        val camera = manual.forCheck(photosOnly = true)
        assertEquals("", camera.text)
        assertEquals("cosmetics", camera.category)
        assertFalse(camera.complete)
        assertFalse(camera.textTruncated)
        assertEquals(manual, manual.forCheck(photosOnly = false))
    }
}
