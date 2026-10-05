package org.veguide.android

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.oned.UPCEReader
import java.nio.ByteBuffer

/** Reads only the luminance plane; no bitmap, photo file, OCR, or network request is created. */
internal class RetailBarcodeDecoder {
    private val reader = MultiFormatReader().apply { setHints(mapOf(
        DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.ITF, BarcodeFormat.RSS_14),
        DecodeHintType.TRY_HARDER to true,
    )) }
    fun decode(bytes: ByteArray, width: Int, height: Int): String? {
        require(width > 0 && height > 0 && bytes.size == width * height)
        // Camera sensors and packages can both be rotated. TRY_HARDER cannot rotate a planar source.
        for (rotated in listOf(false, true)) {
            val pixels = if (rotated) rotateLuminance(bytes, width, height) else bytes
            val w = if (rotated) height else width
            val h = if (rotated) width else height
            try {
                val result = reader.decodeWithState(BinaryBitmap(HybridBinarizer(PlanarYUVLuminanceSource(pixels, w, h, 0, 0, w, h, false))))
                val code = if (result.barcodeFormat == BarcodeFormat.UPC_E) UPCEReader.convertUPCEtoUPCA(result.text) else result.text
                if (validGtin(code)) return code
            } catch (_: ReaderException) { /* No valid supported code in this frame. */ }
            finally { reader.reset() }
        }
        return null
    }
}

internal fun copyLuminance(buffer: ByteBuffer, width: Int, height: Int, rowStride: Int, pixelStride: Int,
    left: Int = 0, top: Int = 0): ByteArray {
    require(width > 0 && height > 0 && rowStride > 0 && pixelStride > 0 && left >= 0 && top >= 0)
    val base = buffer.position()
    val last = base.toLong() + (top.toLong() + height - 1) * rowStride + (left.toLong() + width - 1) * pixelStride
    require(last < buffer.limit())
    return ByteArray(width * height) { index -> buffer.get(base + (top + index / width) * rowStride + (left + index % width) * pixelStride) }
}
internal fun rotateLuminance(bytes: ByteArray, width: Int, height: Int): ByteArray = ByteArray(bytes.size).also { output ->
    for (y in 0 until height) for (x in 0 until width) output[x * height + height - y - 1] = bytes[y * width + x]
}

internal data class BarcodeObservation(val barcode: String, val revision: Long, val lookup: Boolean)
/** A camera session cannot re-query the same retail code or apply a response to a later product. */
internal class BarcodeScanCoordinator(private val now: () -> Long = { System.nanoTime() / 1_000_000 }) {
    private var active = false
    private var offline = false
    private var allowOfflineLookup = false
    private var current = ""
    private var revision = 0L
    private var ignored = ""
    private val recent = linkedMapOf<String, Long>()
    @Synchronized fun configure(active: Boolean, offline: Boolean, allowOfflineLookup: Boolean = false) {
        if (this.active != active || this.offline != offline) { revision++; current = "" }
        if (!active) ignored = ""
        this.active = active; this.offline = offline; this.allowOfflineLookup = allowOfflineLookup
    }
    @Synchronized fun observe(barcode: String): BarcodeObservation? {
        if (!active || !validGtin(barcode)) return null
        val canonical = barcode.padStart(14, '0')
        if (canonical == ignored || canonical == current) return null
        ignored = ""
        current = canonical; revision++
        val clock = now()
        recent.entries.removeAll { clock - it.value >= 10 * 60_000 }
        val lookup = (!offline || allowOfflineLookup) && canonical !in recent
        if (lookup) {
            recent[canonical] = clock
            if (recent.size > 32) recent.remove(recent.keys.first())
        }
        return BarcodeObservation(barcode, revision, lookup)
    }
    @Synchronized fun accepts(observation: BarcodeObservation): Boolean = active && (!offline || allowOfflineLookup) && observation.revision == revision && observation.barcode.padStart(14, '0') == current
    @Synchronized fun clear() { revision++; ignored = current; current = "" }
}
