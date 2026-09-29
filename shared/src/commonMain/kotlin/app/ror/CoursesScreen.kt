package app.ror

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException

class CoursesState {
    val courses = mutableStateListOf<CourseCount>()
    var loaded by mutableStateOf(false)
    var query by mutableStateOf("")
    var department by mutableStateOf("")
    var error by mutableStateOf("")
}

@Composable
fun CoursesScreen(app: AppState, onError: (Throwable) -> Unit) {
    val state = app.courses
    LaunchedEffect(app.configVersion) {
        if (state.loaded) return@LaunchedEffect
        try {
            val result = Api.courses()
            state.courses.clear()
            state.courses += result.courses
            state.loaded = true
            state.error = ""
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            state.error = e.message ?: "Could not load courses."
            onError(e)
        }
    }
    val departments = state.courses.groupBy { it.department }.entries
        .sortedByDescending { entry -> entry.value.sumOf { it.count } }
        .map { it.key }
    val shown = state.courses.filter { course ->
        (state.department.isBlank() || course.department == state.department) &&
            (state.query.isBlank() || course.code.contains(state.query.trim(), ignoreCase = true))
    }

    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 150.dp),
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(20.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item(span = { GridItemSpan(maxLineSpan) }) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(bottom = 8.dp)) {
                Text("Courses", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
                Text(
                    "Every course code students have mentioned, with how many threads talk about it.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = state.query,
                    onValueChange = { state.query = it },
                    modifier = Modifier.widthIn(max = 480.dp).fillMaxWidth(),
                    singleLine = true,
                    shape = RoundedCornerShape(14.dp),
                    placeholder = { Text("Filter by code, e.g. CS-UH or 1001") },
                    leadingIcon = { Icon(RorIcons.Search, contentDescription = null) },
                )
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    FilterChip(selected = state.department.isBlank(), onClick = { state.department = "" }, label = { Text("All") })
                    departments.take(24).forEach { department ->
                        FilterChip(
                            selected = state.department == department,
                            onClick = { state.department = if (state.department == department) "" else department },
                            label = { Text(department) },
                        )
                    }
                }
                if (state.error.isNotBlank()) ErrorBanner(state.error)
                if (!state.loaded && state.error.isBlank()) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        }
        items(shown, key = { it.code }) { course ->
            Card(
                onClick = { app.open(Overlay.Course(course.code)) },
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                shape = RoundedCornerShape(12.dp),
            ) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(course.code, style = MaterialTheme.typography.labelLarge, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
                    Text(
                        "${course.count} ${if (course.count == 1) "thread" else "threads"} · ${formatDate(course.latest)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
fun CourseScreen(code: String, app: AppState, onError: (Throwable) -> Unit) {
    var data by remember(code) { mutableStateOf<CoursePosts?>(null) }
    var error by remember(code) { mutableStateOf("") }
    LaunchedEffect(code) {
        try {
            data = Api.course(code)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message ?: "Could not load this course."
            onError(e)
        }
    }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            TextButton(onClick = { app.back() }, contentPadding = PaddingValues(horizontal = 8.dp)) {
                Icon(RorIcons.Back, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text("Back")
            }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(code, style = MaterialTheme.typography.headlineMedium, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
                val total = data?.total
                Text(
                    when {
                        error.isNotBlank() -> error
                        total == null -> "Loading…"
                        else -> "$total ${if (total == 1) "thread mentions" else "threads mention"} this course."
                    },
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Button(onClick = {
                    app.askAbout("What do students say about $code? Cover the workload, grading, professors and whether it is worth taking.", autoSend = true)
                }) {
                    Icon(RorIcons.Ask, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Ask what students think")
                }
            }
        }
        if (data == null && error.isBlank()) item { LinearProgressIndicator(Modifier.fillMaxWidth().widthIn(max = 820.dp)) }
        items(data?.posts.orEmpty(), key = { it.id }) { post ->
            Box(Modifier.widthIn(max = 820.dp)) {
                PostCard(post, showSnippet = false, onClick = { app.open(Overlay.Post(post.id)) })
            }
        }
    }
}
