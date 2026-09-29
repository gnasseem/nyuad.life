package app.ror

import android.content.Context

actual object Prefs {
    private fun preferences() = (AppContext.android as? Context)
        ?.getSharedPreferences("ror_answers_settings", Context.MODE_PRIVATE)

    actual fun get(name: String): String? = preferences()?.getString(name, null)

    actual fun set(name: String, value: String) {
        checkNotNull(preferences()) { "Android application context is not initialized." }
            .edit().putString(name, value).apply()
    }
}

fun Prefs.init(context: Context) {
    AppContext.android = context.applicationContext
}
