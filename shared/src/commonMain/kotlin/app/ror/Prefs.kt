package app.ror

/** Small on-device key/value store for the server URL, access code and theme. Nothing secret lives here. */
expect object Prefs {
    fun get(name: String): String?
    fun set(name: String, value: String)
}

object AppContext {
    var android: Any? = null
}

enum class ThemeMode { System, Light, Dark }

object Settings {
    const val DefaultServer = "http://localhost:8787"

    fun serverUrl(): String = Prefs.get("server_url").orEmpty().trim().trimEnd('/')
    fun setServerUrl(value: String) = Prefs.set("server_url", value.trim().trimEnd('/'))

    fun accessCode(): String = Prefs.get("access_code").orEmpty().trim()
    fun setAccessCode(value: String) = Prefs.set("access_code", value.trim())

    fun themeMode(): ThemeMode = runCatching { ThemeMode.valueOf(Prefs.get("theme").orEmpty()) }.getOrDefault(ThemeMode.System)
    fun setThemeMode(mode: ThemeMode) = Prefs.set("theme", mode.name)
}
