package app.ror

expect object KeyStore {
    fun get(name: String): String?
    fun set(name: String, value: String)
}

object AppContext {
    var android: Any? = null
}
