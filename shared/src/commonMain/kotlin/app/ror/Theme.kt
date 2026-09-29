package app.ror

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LightColors = lightColorScheme(
    primary = Color(0xFF6D28D9),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFEFE9FB),
    onPrimaryContainer = Color(0xFF4C1D95),
    secondary = Color(0xFF8B5CF6),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFEFE9FB),
    onSecondaryContainer = Color(0xFF4C1D95),
    background = Color(0xFFFAF8F3),
    onBackground = Color(0xFF1C1A17),
    surface = Color(0xFFFAF8F3),
    onSurface = Color(0xFF1C1A17),
    surfaceContainer = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFF6F3EC),
    surfaceContainerHigh = Color(0xFFF1EEE6),
    surfaceContainerHighest = Color(0xFFEAE6DD),
    surfaceVariant = Color(0xFFF1EEE6),
    onSurfaceVariant = Color(0xFF5B564D),
    outline = Color(0xFFD3CDBF),
    outlineVariant = Color(0xFFE6E1D6),
    error = Color(0xFFB91C1C),
    onError = Color.White,
    errorContainer = Color(0xFFFEE2E2),
    onErrorContainer = Color(0xFF7F1D1D),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFA78BFA),
    onPrimary = Color(0xFF1A1030),
    primaryContainer = Color(0xFF2A2140),
    onPrimaryContainer = Color(0xFFD9CCFF),
    secondary = Color(0xFFC4B5FD),
    onSecondary = Color(0xFF1A1030),
    secondaryContainer = Color(0xFF2A2140),
    onSecondaryContainer = Color(0xFFD9CCFF),
    background = Color(0xFF121016),
    onBackground = Color(0xFFF0ECF6),
    surface = Color(0xFF121016),
    onSurface = Color(0xFFF0ECF6),
    surfaceContainer = Color(0xFF1A171F),
    surfaceContainerLow = Color(0xFF16131B),
    surfaceContainerHigh = Color(0xFF221E2A),
    surfaceContainerHighest = Color(0xFF2A2533),
    surfaceVariant = Color(0xFF221E2A),
    onSurfaceVariant = Color(0xFFB4ADC2),
    outline = Color(0xFF3A3446),
    outlineVariant = Color(0xFF2A2533),
    error = Color(0xFFF87171),
    onError = Color(0xFF3B1D1D),
    errorContainer = Color(0xFF3B1D1D),
    onErrorContainer = Color(0xFFFECACA),
)

@Composable
fun RorTheme(mode: ThemeMode, content: @Composable () -> Unit) {
    val dark = when (mode) {
        ThemeMode.System -> isSystemInDarkTheme()
        ThemeMode.Light -> false
        ThemeMode.Dark -> true
    }
    MaterialTheme(colorScheme = if (dark) DarkColors else LightColors, content = content)
}
