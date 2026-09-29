package app.ror

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.backhandler.BackHandler
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

enum class Tab(val label: String, val icon: ImageVector) {
    Ask("Ask", RorIcons.Ask),
    Browse("Browse", RorIcons.Search),
    Courses("Courses", RorIcons.Book),
    Settings("Settings", RorIcons.Settings),
}

sealed interface Overlay {
    data class Post(val id: String) : Overlay
    data class Course(val code: String) : Overlay
}

data class PendingQuestion(val question: String, val autoSend: Boolean)

/** Everything that should survive switching tabs: the conversation, search state, home data and navigation. */
class AppState {
    var tab by mutableStateOf(if (Settings.serverUrl().isBlank()) Tab.Settings else Tab.Ask)
    val overlays = mutableStateListOf<Overlay>()
    var home by mutableStateOf<HomePayload?>(null)
    var homeError by mutableStateOf("")
    var themeMode by mutableStateOf(Settings.themeMode())
    var configVersion by mutableStateOf(0)
    var pendingQuestion by mutableStateOf<PendingQuestion?>(null)
    val ask = AskState()
    val browse = BrowseState()
    val courses = CoursesState()

    fun open(overlay: Overlay) {
        overlays += overlay
    }

    fun back(): Boolean = overlays.removeLastOrNull() != null

    fun askAbout(question: String, autoSend: Boolean) {
        pendingQuestion = PendingQuestion(question, autoSend)
        overlays.clear()
        tab = Tab.Ask
    }

    fun goToSettings() {
        overlays.clear()
        tab = Tab.Settings
    }
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun App() {
    val app = remember { AppState() }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val showMessage: (String) -> Unit = { message -> scope.launch { snackbar.showSnackbar(message) } }

    LaunchedEffect(app.configVersion) {
        if (Settings.serverUrl().isBlank()) return@LaunchedEffect
        app.homeError = ""
        runCatching { Api.home() }
            .onSuccess { app.home = it }
            .onFailure { app.homeError = it.message ?: "Could not load the archive." }
    }

    RorTheme(app.themeMode) {
        BackHandler(enabled = app.overlays.isNotEmpty()) { app.back() }
        BoxWithConstraints(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
            val wide = maxWidth >= 840.dp
            Scaffold(
                containerColor = MaterialTheme.colorScheme.background,
                snackbarHost = { SnackbarHost(snackbar) },
                bottomBar = { if (!wide) BottomTabs(app) },
            ) { padding ->
                Row(Modifier.fillMaxSize().padding(padding)) {
                    if (wide) SideRail(app)
                    Box(Modifier.weight(1f).fillMaxHeight()) {
                        Content(app, wide, showMessage)
                    }
                }
            }
        }
    }
}

@Composable
private fun Content(app: AppState, wide: Boolean, showMessage: (String) -> Unit) {
    val onError: (Throwable) -> Unit = { error ->
        val api = error as? ApiException
        if (api != null && (api.needsAccessCode || api.needsServer)) {
            showMessage(api.message ?: "Check the server settings.")
            app.goToSettings()
        } else {
            showMessage(error.message ?: "Something went wrong.")
        }
    }
    when (val overlay = app.overlays.lastOrNull()) {
        is Overlay.Post -> PostScreen(overlay.id, app, onError)
        is Overlay.Course -> CourseScreen(overlay.code, app, onError)
        null -> when (app.tab) {
            Tab.Ask -> AskScreen(app, wide, onError)
            Tab.Browse -> BrowseScreen(app, onError)
            Tab.Courses -> CoursesScreen(app, onError)
            Tab.Settings -> SettingsScreen(app, showMessage)
        }
    }
}

@Composable
private fun SideRail(app: AppState) {
    NavigationRail(
        containerColor = MaterialTheme.colorScheme.background,
        header = {
            Column(Modifier.padding(top = 8.dp, bottom = 12.dp)) {
                Text("ROR", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Black, color = MaterialTheme.colorScheme.primary)
            }
        },
    ) {
        Tab.entries.forEach { tab ->
            NavigationRailItem(
                selected = app.tab == tab && app.overlays.isEmpty(),
                onClick = {
                    app.overlays.clear()
                    app.tab = tab
                },
                icon = { Icon(tab.icon, contentDescription = tab.label) },
                label = { Text(tab.label) },
            )
        }
    }
}

@Composable
private fun BottomTabs(app: AppState) {
    NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceContainer) {
        Tab.entries.forEach { tab ->
            NavigationBarItem(
                selected = app.tab == tab && app.overlays.isEmpty(),
                onClick = {
                    app.overlays.clear()
                    app.tab = tab
                },
                icon = { Icon(tab.icon, contentDescription = tab.label) },
                label = { Text(tab.label) },
            )
        }
    }
}
