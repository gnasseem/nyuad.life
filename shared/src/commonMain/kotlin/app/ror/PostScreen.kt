package app.ror

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PostScreen(id: String, app: AppState, onError: (Throwable) -> Unit) {
    var data by remember(id) { mutableStateOf<PostResponse?>(null) }
    var error by remember(id) { mutableStateOf("") }
    val uriHandler = LocalUriHandler.current
    val colors = MaterialTheme.colorScheme

    LaunchedEffect(id) {
        try {
            data = Api.post(id)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message ?: "Could not load this post."
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
        if (error.isNotBlank()) item { ErrorBanner(error) }
        if (data == null && error.isBlank()) item { LinearProgressIndicator(Modifier.fillMaxWidth().widthIn(max = 820.dp)) }
        data?.let { response ->
            val post = response.post
            item {
                Card(
                    modifier = Modifier.widthIn(max = 820.dp).fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = colors.surfaceContainer),
                    border = BorderStroke(1.dp, colors.outlineVariant),
                    shape = RoundedCornerShape(14.dp),
                ) {
                    Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text(post.author.ifBlank { "Unknown" }, style = MaterialTheme.typography.titleSmall)
                            Text(formatDate(post.date), style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
                            Text("${post.commentCount} ${if (post.commentCount == 1) "comment" else "comments"}", style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
                            if (post.reactions > 0) Text("${post.reactions} reactions", style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
                        }
                        SelectionContainer { Text(post.text, style = MaterialTheme.typography.bodyLarge) }
                        if (post.courses.isNotEmpty() || post.topics.any { it != "general" }) {
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                post.courses.forEach { code ->
                                    AssistChip(onClick = { app.open(Overlay.Course(code)) }, label = { Text(code) })
                                }
                                post.topics.filter { it != "general" }.forEach { Tag(topicLabel(it)) }
                            }
                        }
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Button(onClick = {
                                val lead = post.text.split(Regex("(?<=[.?!])\\s")).firstOrNull()?.take(140).orEmpty()
                                app.askAbout("What did students say about this: \"$lead\"", autoSend = false)
                            }) {
                                Icon(RorIcons.Ask, contentDescription = null, modifier = Modifier.size(16.dp))
                                Spacer(Modifier.width(6.dp))
                                Text("Ask about this")
                            }
                            if (post.url.isNotBlank()) {
                                OutlinedButton(onClick = { uriHandler.openUri(post.url) }) {
                                    Icon(RorIcons.OpenInNew, contentDescription = null, modifier = Modifier.size(16.dp))
                                    Spacer(Modifier.width(6.dp))
                                    Text("Open on Facebook")
                                }
                            }
                        }
                    }
                }
            }
            item {
                val missing = post.commentCount - post.comments.size
                SectionTitle("${post.comments.size} ${if (post.comments.size == 1) "comment" else "comments"}${if (missing > 0) " ($missing not captured yet)" else ""}")
            }
            if (post.comments.isEmpty()) {
                item { Text("No comments were saved for this post.", color = colors.onSurfaceVariant) }
            }
            items(post.comments) { comment ->
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = colors.surfaceContainerLow,
                    modifier = Modifier.widthIn(max = 820.dp).fillMaxWidth(),
                ) {
                    Column(Modifier.padding(horizontal = 14.dp, vertical = 11.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text(comment.author.ifBlank { "Someone" }, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                            Text(formatDate(comment.date), style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
                        }
                        SelectionContainer { Text(comment.text, style = MaterialTheme.typography.bodyMedium) }
                    }
                }
            }
            if (response.related.isNotEmpty()) {
                item { SectionTitle("Related threads") }
                items(response.related, key = { "related-${it.id}" }) { related ->
                    Box(Modifier.widthIn(max = 820.dp)) {
                        PostCard(related, showSnippet = false, onClick = { app.open(Overlay.Post(related.id)) })
                    }
                }
            }
        }
    }
}
