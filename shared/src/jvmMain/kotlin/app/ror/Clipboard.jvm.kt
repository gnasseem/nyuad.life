package app.ror

import java.awt.Toolkit
import java.awt.datatransfer.StringSelection

actual fun copyText(text: String) {
    runCatching { Toolkit.getDefaultToolkit().systemClipboard.setContents(StringSelection(text), null) }
}
