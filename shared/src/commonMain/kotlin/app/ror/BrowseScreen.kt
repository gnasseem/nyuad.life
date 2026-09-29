package app.ror

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

class BrowseState {
    var query by mutableStateOf("")
    var topic by mutableStateOf("")
    var sort by mutableStateOf("")
    val results = mutableStateListOf<PostSummary>()
    var total by mutableStateOf(0)
    var page by mutableStateOf(1)
    var loading by mutableStateOf(false)
    var error by mutableStateOf("")
}

private data class Filters(val query: String, val topic: String, val sort: String)

@OptIn(FlowPreview::class)
@Composable
fun BrowseScreen(app: AppState, onError: (Throwable) -> Unit) {
    val state = app.browse
    val scope = rememberCoroutineScope()

    LaunchedEffect(app.configVersion) {
        snapshotFlow { Filters(state.query.trim(), state.topic, state.sort) }
            .debounce(350)
            .distinctUntilChanged()
            .collectLatest { filters ->
                if (filters.query.isNotEmpty() && filters.query.length < 2) return@collectLatest
                state.loading = true
                state.error = ""
                try {
                    val result = Api.search(filters.query, filters.topic, filters.sort, page = 1)
                    state.results.clear()
                    state.results += result.results
                    state.total = result.total
                    state.page = 1
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    state.error = e.message ?: "Search failed."
                    onError(e)
                } finally {
                    state.loading = false
                }
            }
    }

    fun loadMore() {
        if (state.loading) return
        scope.launch {
            state.loading = true
            try {
                val next = state.page + 1
                val result = Api.search(state.query.trim(), state.topic, state.sort, page = next)
                state.results += result.results
                state.page = next
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                state.error = e.message ?: "Could not load more."
            } finally {
                state.loading = false
            }
        }
    }

    val sorts = buildList {
        if (state.query.trim().isNotEmpty()) add("relevance" to "Most relevant")
        add("newest" to "Newest")
        add("discussed" to "Most discussed")
        add("oldest" to "Oldest")
    }
    val effectiveSort = state.sort.ifBlank { if (state.query.trim().isNotEmpty()) "relevance" else "newest" }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 20.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            Column(Modifier.widthIn(max = 820.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Browse the archive", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold)
                Text("Search every post and comment, or filter by topic.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedTextField(
                    value = state.query,
                    onValueChange = { state.query = it },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    shape = RoundedCornerShape(14.dp),
                    placeholder = { Text("e.g. Dania calculus, A5 laundry, Shanghai housing") },
                    leadingIcon = { Icon(RorIcons.Search, contentDescription = null) },
                    trailingIcon = {
                        if (state.query.isNotEmpty()) {
                            IconButton(onClick = { state.query = "" }) { Icon(RorIcons.Clear, contentDescription = "Clear", modifier = Modifier.size(18.dp)) }
                        }
                    },
                )
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    sorts.forEach { (id, label) ->
                        FilterChip(selected = effectiveSort == id, onClick = { state.sort = id }, label = { Text(label) })
                    }
                }
                val topics = app.home?.topics.orEmpty()
                if (topics.isNotEmpty()) {
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        topics.take(14).forEach { topic ->
                            FilterChip(
                                selected = state.topic == topic.id,
                                onClick = { state.topic = if (state.topic == topic.id) "" else topic.id },
                                label = { Text(topicLabel(topic.id)) },
                            )
                        }
                    }
                }
                if (state.error.isNotBlank()) ErrorBanner(state.error)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (state.loading && state.results.isEmpty()) "Searching…" else "${state.total} ${if (state.total == 1) "post" else "posts"}",
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        }
        items(state.results, key = { it.id }) { post ->
            androidx.compose.foundation.layout.Box(Modifier.widthIn(max = 820.dp)) {
                PostCard(post, onClick = { app.open(Overlay.Post(post.id)) })
            }
        }
        if (!state.loading && state.results.isEmpty() && state.error.isBlank()) {
            item {
                Text(
                    "Nothing matched. Try fewer words, a surname, or a course code like CS-UH 1001.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 24.dp),
                )
            }
        }
        if (state.results.size < state.total) {
            item {
                OutlinedButton(onClick = { loadMore() }, enabled = !state.loading, modifier = Modifier.padding(vertical = 8.dp)) {
                    Text(if (state.loading) "Loading…" else "Load more")
                }
            }
        }
    }
}
