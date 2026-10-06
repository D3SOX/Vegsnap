package org.veguide.android

import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.Settings
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.*
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test

class PhotoGalleryTest {
    @get:Rule val compose = createComposeRule()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var directory: File
    private lateinit var photos: List<Uri>
    private val removed = mutableListOf<Uri>()
    private var closed = false
    private var previousFontScale = 1f

    @Before fun createPhotos() {
        previousFontScale = Settings.System.getFloat(context.contentResolver, Settings.System.FONT_SCALE, 1f)
        directory = Files.createTempDirectory(context.cacheDir.toPath(), "gallery-test-").toFile()
        photos = listOf(Color.RED, Color.GREEN, Color.BLUE).mapIndexed { index, color ->
            val file = File(directory, "$index.png")
            val bitmap = Bitmap.createBitmap(240, 320, Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(color)
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
            Uri.fromFile(file)
        }
    }

    @After fun deletePhotos() {
        directory.deleteRecursively()
        if (Settings.System.getFloat(context.contentResolver, Settings.System.FONT_SCALE, 1f) != previousFontScale) {
            setFontScale(previousFontScale)
        }
    }

    private fun setFontScale(scale: Float) {
        val output = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand("settings put system font_scale $scale")
        ParcelFileDescriptor.AutoCloseInputStream(output).bufferedReader().use { it.readText() }
        compose.waitUntil(timeoutMillis = 5_000) { context.resources.configuration.fontScale == scale }
    }

    private fun showGallery(initialIndex: Int = 0, editable: Boolean = true, dark: Boolean = false) {
        compose.setContent {
            var currentPhotos by remember { mutableStateOf(photos) }
            var visible by remember { mutableStateOf(true) }
            MaterialTheme(colorScheme = if (dark) darkColorScheme() else lightColorScheme()) {
                if (visible) PhotoGallery(currentPhotos, photos[initialIndex], true,
                    onRemove = if (editable) { { uri ->
                        removed.add(uri)
                        currentPhotos = currentPhotos.filterNot { it == uri }
                    } } else null,
                    onClose = { closed = true; visible = false })
            }
        }
        compose.waitForIdle()
    }

    private fun control(resource: Int) = compose.onNodeWithContentDescription(context.getString(resource))
    private fun position(index: Int, total: Int) = compose.onNodeWithText(context.getString(R.string.photo_position, index, total))
    private fun remove(index: Int) = compose.onNodeWithContentDescription(context.getString(R.string.remove_photo, index))

    @Test fun swipesAndButtonsChangeTheSelectedPhoto() {
        showGallery()
        position(1, 3).assertIsDisplayed()
        control(R.string.previous_photo).assertIsNotEnabled()
        compose.onNodeWithTag("photo-pager").performTouchInput { swipeLeft() }
        position(2, 3).assertIsDisplayed()
        control(R.string.next_photo).performClick()
        position(3, 3).assertIsDisplayed()
        control(R.string.next_photo).assertIsNotEnabled()
        control(R.string.previous_photo).performClick()
        position(2, 3).assertIsDisplayed()
        compose.onNodeWithTag("photo-pager").performTouchInput { swipeRight() }
        position(1, 3).assertIsDisplayed()
        remove(1).performClick()
        compose.runOnIdle { assertEquals(listOf(photos[0]), removed) }
    }

    @Test fun deletingMiddleThenLastPhotoKeepsSelectionAndFinallyCloses() {
        showGallery(initialIndex = 1)
        position(2, 3).assertIsDisplayed()
        remove(2).performClick()
        position(2, 2).assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf(photos[1]), removed) }
        remove(2).performClick()
        position(1, 1).assertIsDisplayed()
        compose.runOnIdle { assertEquals(listOf(photos[1], photos[2]), removed) }
        control(R.string.previous_photo).assertIsNotEnabled()
        control(R.string.next_photo).assertIsNotEnabled()
        remove(1).performClick()
        compose.onNodeWithTag("photo-pager").assertDoesNotExist()
        compose.runOnIdle {
            assertTrue(closed)
            assertEquals(listOf(photos[1], photos[2], photos[0]), removed)
        }
    }

    @Test fun downwardSwipeDismissesThePhotoPreview() {
        showGallery()
        compose.onNodeWithTag("photo-pager").performTouchInput { swipeDown(durationMillis = 300) }
        compose.onNodeWithTag("photo-pager").assertDoesNotExist()
        compose.runOnIdle { assertTrue(closed) }
    }

    @Test fun shortDownwardDragKeepsPreviewOpenAndHorizontalPagingWorks() {
        showGallery()
        val pager = compose.onNodeWithTag("photo-pager")
        val originalTop = pager.fetchSemanticsNode().boundsInRoot.top
        pager.performTouchInput { swipe(center, Offset(center.x, center.y + height * 0.025f), durationMillis = 200) }
        position(1, 3).assertIsDisplayed()
        compose.runOnIdle { assertFalse(closed) }
        assertTrue("A short drag must spring back", kotlin.math.abs(pager.fetchSemanticsNode().boundsInRoot.top - originalTop) <= 2f)
        pager.performTouchInput { swipeLeft() }
        position(2, 3).assertIsDisplayed()
    }

    @Test fun historyGalleryAllowsNavigationAndCloseWithoutDeletion() {
        showGallery(editable = false)
        remove(1).assertDoesNotExist()
        control(R.string.next_photo).performClick()
        position(2, 3).assertIsDisplayed()
        remove(2).assertDoesNotExist()
        control(R.string.close).performClick()
        compose.onNodeWithTag("photo-pager").assertDoesNotExist()
        compose.runOnIdle { assertTrue(closed); assertTrue(removed.isEmpty()) }
    }

    @Test fun lightGalleryControlsStayBelowThePhoto() = verifyToolbar(dark = false, fontScale = 1f)
    @Test fun darkGalleryControlsStayBelowThePhotoAtLargeFont() = verifyToolbar(dark = true, fontScale = 2f)

    private fun verifyToolbar(dark: Boolean, fontScale: Float) {
        if (fontScale != previousFontScale) setFontScale(fontScale)
        showGallery(initialIndex = 1, dark = dark)
        val photo = compose.onNodeWithTag("photo-pager").fetchSemanticsNode().boundsInRoot
        val controls = listOf(control(R.string.close), control(R.string.previous_photo), position(2, 3),
            control(R.string.next_photo), remove(2))
        val bounds = controls.map { node ->
            node.assertIsDisplayed()
            node.fetchSemanticsNode().boundsInRoot
        }
        bounds.forEach { rect -> assertTrue("Every gallery control must be below the photo", rect.top >= photo.bottom) }
        bounds.zipWithNext().forEach { (left, right) ->
            assertTrue("Toolbar controls must not overlap", left.right <= right.left)
        }
        val name = if (dark) "gallery-toolbar-dark-large-font.png" else "gallery-toolbar-light.png"
        val image = compose.onNode(isDialog()).captureToImage().asAndroidBitmap()
        File(context.filesDir, name).outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
