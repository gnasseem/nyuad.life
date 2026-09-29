package app.ror

/** Copies plain text to the system clipboard. Platform-specific because Compose's common clipboard API is still in flux. */
expect fun copyText(text: String)
