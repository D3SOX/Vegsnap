package app.vegsnap

import kotlinx.coroutines.CancellationException
import java.io.IOException

internal enum class ChatGPTSignInStage(val messageId: Int) {
    TIMEOUT(R.string.chatgpt_signin_timeout),
    CALLBACK(R.string.chatgpt_signin_callback_error),
    EXCHANGE(R.string.chatgpt_signin_exchange_error),
    GRANT(R.string.chatgpt_signin_grant_error),
    IDENTITY(R.string.chatgpt_signin_identity_error),
    ACCOUNT(R.string.chatgpt_signin_account_error),
    STORAGE(R.string.chatgpt_signin_storage_error),
}
internal class ChatGPTSignInException(val stage: ChatGPTSignInStage) : IOException("ChatGPT sign-in failed at ${stage.name.lowercase()}")
internal fun chatGPTSignInMessage(error: Exception): Int =
    (error as? ChatGPTSignInException)?.stage?.messageId ?: R.string.chatgpt_signin_error

internal suspend fun <T> chatGPTSignInStage(stage: ChatGPTSignInStage, action: suspend () -> T): T = try {
    action()
} catch (error: CancellationException) { throw error }
catch (_: Exception) { throw ChatGPTSignInException(stage) }

/** Return control before network work: Android may delay that work while the app is backgrounded. */
internal suspend fun <T> completeChatGPTCallback(exchangeAndSave: suspend () -> T, handOffToApp: () -> Unit): T {
    // This page reports a pending connection, never success. The app owns the final result.
    // A closed browser must not abort an otherwise valid sign-in.
    runCatching { handOffToApp() }
    return exchangeAndSave()
}

internal fun sendChatGPTBrowserResponse(socket: java.net.Socket, response: ByteArray) {
    socket.use {
        it.getOutputStream().write(response)
        it.getOutputStream().flush()
    }
}

internal const val CHATGPT_APP_RETURN = "vegsnap://auth/complete"
internal const val CHATGPT_APP_INTENT = "intent://auth/complete#Intent;scheme=vegsnap;package=app.vegsnap;launchFlags=0x24000000;end"
internal fun isChatGPTAppReturn(uri: String?): Boolean = uri == CHATGPT_APP_RETURN

internal fun chatGPTCompletionPage(template: String, returnAutomatically: Boolean, title: String, message: String, action: String, language: String = "en"): String {
    fun escape(value: String): String = value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace("\"", "&quot;").replace("'", "&#39;")
    val script = "<script nonce=\"vegsnap-auth-return\">history.replaceState(null,'','/auth/done');" +
        (if (returnAutomatically) "setTimeout(function(){window.location.replace('$CHATGPT_APP_INTENT')},350);" else "") + "</script>"
    return template.replace("<html lang=\"en\">", "<html lang=\"${if (language == "de") "de" else "en"}\">")
        .replace("{{TITLE}}", escape(title)).replace("{{MESSAGE}}", escape(message))
        .replace("{{ACTION}}", "<a href=\"$CHATGPT_APP_INTENT\">${escape(action)}</a>").replace("{{SCRIPT}}", script)
}

internal fun chatGPTCompletionResponse(html: String, accepted: Boolean): ByteArray {
    val body = html.toByteArray(Charsets.UTF_8)
    val status = if (accepted) "200 OK" else "400 Bad Request"
    val headers = "HTTP/1.1 $status\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${body.size}\r\n" +
        "Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\n" +
        "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-vegsnap-auth-return'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'\r\nConnection: close\r\n\r\n"
    return headers.toByteArray(Charsets.US_ASCII) + body
}
