package app.ror

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context

actual fun copyText(text: String) {
    val context = AppContext.android as? Context ?: return
    val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    manager.setPrimaryClip(ClipData.newPlainText("ROR Answers", text))
}
