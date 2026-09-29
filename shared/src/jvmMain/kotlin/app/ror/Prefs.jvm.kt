package app.ror

import java.nio.file.Files
import java.nio.file.Path
import java.util.Properties

actual object Prefs {
    private val directory: Path = Path.of(System.getProperty("user.home"), ".ror-answers")
    private val file: Path = directory.resolve("settings.properties")

    actual fun get(name: String): String? = synchronized(this) {
        if (!Files.exists(file)) return@synchronized null
        Properties().apply { Files.newInputStream(file).use(::load) }.getProperty(name)
    }

    actual fun set(name: String, value: String) = synchronized(this) {
        Files.createDirectories(directory)
        val properties = Properties()
        if (Files.exists(file)) Files.newInputStream(file).use(properties::load)
        properties.setProperty(name, value)
        Files.newOutputStream(file).use { properties.store(it, "ROR Answers") }
    }
}
