package app.vegsnap

import java.io.IOException
import java.time.format.DateTimeParseException
import org.json.JSONException

/** Deliberately excludes response bodies and URLs, which can contain private query parameters. */
internal class RegionalPackHttpException(val status: Int) : IOException("HTTP $status")
internal class RegionalPackNetworkException : IOException("Regional download connection failed")

internal fun regionalPackErrorMessage(error: Exception, catalog: Boolean): Int = when {
    error is RegionalPackHttpException -> when (error.status) {
        404 -> if (catalog) R.string.offline_catalog_not_available else R.string.offline_region_not_available
        429 -> R.string.offline_download_rate_limited
        in 500..599 -> R.string.offline_download_server_error
        else -> R.string.offline_download_rejected
    }
    error is RegionalPackNetworkException -> R.string.offline_download_network_error
    error is IllegalArgumentException || error is JSONException || error is DateTimeParseException ->
        if (catalog) R.string.offline_catalog_invalid else R.string.offline_download_invalid
    error is IOException -> R.string.offline_download_storage_error
    else -> R.string.offline_download_error
}
