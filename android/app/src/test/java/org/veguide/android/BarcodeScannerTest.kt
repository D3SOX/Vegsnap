package org.veguide.android

import com.google.zxing.BarcodeFormat
import com.google.zxing.MultiFormatWriter
import org.junit.Assert.*
import org.junit.Test
import java.nio.ByteBuffer

class BarcodeScannerTest {
    private val first = "4006381333931"

    @Test fun realRetailCodeDecodesInBothCameraOrientationsAndRejectsBlankFrames() {
        val matrix = MultiFormatWriter().encode(first, BarcodeFormat.EAN_13, 640, 240)
        val pixels = ByteArray(matrix.width * matrix.height) { if (matrix[it % matrix.width, it / matrix.width]) 0 else 255.toByte() }
        val decoder = RetailBarcodeDecoder()
        assertEquals(first, decoder.decode(pixels, matrix.width, matrix.height))
        assertEquals(first, decoder.decode(rotateLuminance(pixels, matrix.width, matrix.height), matrix.height, matrix.width))
        assertNull(decoder.decode(ByteArray(640 * 240) { 255.toByte() }, 640, 240))
    }

    @Test fun compressedUpcExpandsToRetailIdentityAndQrCodesAreIgnored() {
        val writer = MultiFormatWriter()
        val decoder = RetailBarcodeDecoder()
        fun decode(value: String, format: BarcodeFormat): String? {
            val matrix = writer.encode(value, format, 400, 200)
            val pixels = ByteArray(matrix.width * matrix.height) { if (matrix[it % matrix.width, it / matrix.width]) 0 else 255.toByte() }
            return decoder.decode(pixels, matrix.width, matrix.height)
        }
        assertEquals("042100005264", decode("04252614", BarcodeFormat.UPC_E))
        assertNull(decode("https://example.invalid/", BarcodeFormat.QR_CODE))
    }

    @Test fun luminanceCopyUsesPlanePositionCropAndPixelAndRowStridesWithoutMovingBuffer() {
        val buffer = ByteBuffer.wrap(ByteArray(40) { it.toByte() }).apply { position(2) }
        assertArrayEquals(byteArrayOf(12, 14, 20, 22), copyLuminance(buffer, 2, 2, 8, 2, left = 1, top = 1))
        assertEquals(2, buffer.position())
        assertThrows(IllegalArgumentException::class.java) { copyLuminance(buffer, 5, 5, 8, 2) }
    }

    @Test fun inactiveInvalidDuplicateAndEquivalentGtinDoNotStartMoreRequests() {
        val coordinator = BarcodeScanCoordinator()
        assertNull(coordinator.observe(first))
        coordinator.configure(true, false)
        assertNull(coordinator.observe("4006381333932"))
        val observation = requireNotNull(coordinator.observe(first))
        assertTrue(observation.lookup)
        assertTrue(coordinator.accepts(observation))
        assertNull(coordinator.observe(first))
        assertNull(coordinator.observe("0$first"))
        coordinator.configure(false, false)
        assertFalse(coordinator.accepts(observation))
    }

    @Test fun changedProductInvalidatesOldResponseAndReturningProductIsNotQueriedAgain() {
        val coordinator = BarcodeScanCoordinator()
        coordinator.configure(true, false)
        val observation = requireNotNull(coordinator.observe(first))
        // Generate another valid retail code rather than relying on a database product.
        val other = "5901234123457"
        assertTrue(requireNotNull(coordinator.observe(other)).lookup)
        assertFalse(coordinator.accepts(observation))
        assertFalse(requireNotNull(coordinator.observe(first)).lookup)
    }

    @Test fun offlineRetainsBarcodeWithoutLookupAndOnlineEnablesLookup() {
        val coordinator = BarcodeScanCoordinator()
        coordinator.configure(true, true)
        val offline = requireNotNull(coordinator.observe(first))
        assertEquals(first, offline.barcode)
        assertFalse(offline.lookup)
        assertFalse(coordinator.accepts(offline))
        coordinator.configure(true, false)
        assertTrue(requireNotNull(coordinator.observe(first)).lookup)
    }

    @Test fun clearingIgnoresStillVisibleCodeAndExpiryPermitsLaterSessionLookup() {
        var clock = 0L
        val coordinator = BarcodeScanCoordinator { clock }
        coordinator.configure(true, false)
        val firstObservation = requireNotNull(coordinator.observe(first))
        coordinator.clear()
        assertFalse(coordinator.accepts(firstObservation))
        assertNull(coordinator.observe(first))
        coordinator.configure(false, false)
        coordinator.configure(true, false)
        assertFalse(requireNotNull(coordinator.observe(first)).lookup)
        assertNotNull(coordinator.observe("5901234123457"))
        clock = 10 * 60_000L
        assertTrue(requireNotNull(coordinator.observe(first)).lookup)
    }

    @Test fun cameraChecksUseCapturedBarcodeWithoutLeakingManualIdentity() {
        val state = ScanState(name = "Manual name", barcode = "5901234123457", cameraBarcode = first, photoBarcode = first)
        val photoCheck = state.forCheck(photosOnly = true)
        assertEquals(first, photoCheck.barcode)
        assertEquals("", photoCheck.name)
        assertEquals("5901234123457", state.forCheck(photosOnly = false).barcode)
        assertEquals("", state.copy(photoBarcode = "").forCheck(photosOnly = true).barcode)
    }
}
