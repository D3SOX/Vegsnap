package org.veguide.android

internal data class FittedPhoto(val left: Float, val top: Float, val width: Float, val height: Float)
/** FIT_CENTER image bounds; the flying photo follows the full uncropped camera frame. */
internal fun fittedPhoto(width: Float, height: Float, imageAspectRatio: Float): FittedPhoto {
    require(width > 0 && height > 0 && imageAspectRatio > 0)
    val fittedWidth = minOf(width, height * imageAspectRatio)
    val fittedHeight = fittedWidth / imageAspectRatio
    return FittedPhoto((width - fittedWidth) / 2f, (height - fittedHeight) / 2f, fittedWidth, fittedHeight)
}
