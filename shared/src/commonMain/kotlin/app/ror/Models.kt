package app.ror

import kotlinx.serialization.Serializable

@Serializable
data class PostSummary(
    val id: String,
    val url: String = "",
    val author: String = "",
    val date: String = "",
    val text: String = "",
    val preview: String = "",
    val snippet: String = "",
    val commentCount: Int = 0,
    val reactions: Int = 0,
    val topics: List<String> = emptyList(),
    val courses: List<String> = emptyList(),
)

@Serializable
data class Comment(val author: String = "", val date: String = "", val text: String = "")

@Serializable
data class PostDetail(
    val id: String,
    val url: String = "",
    val author: String = "",
    val date: String = "",
    val text: String = "",
    val commentCount: Int = 0,
    val reactions: Int = 0,
    val topics: List<String> = emptyList(),
    val courses: List<String> = emptyList(),
    val comments: List<Comment> = emptyList(),
)

@Serializable
data class PostResponse(val post: PostDetail, val related: List<PostSummary> = emptyList())

@Serializable
data class SourceCard(
    val n: Int,
    val postId: String,
    val url: String = "",
    val author: String = "",
    val date: String = "",
    val text: String = "",
    val commentCount: Int = 0,
    val reactions: Int = 0,
    val topics: List<String> = emptyList(),
    val courses: List<String> = emptyList(),
    val snippet: String = "",
)

@Serializable
data class Stats(
    val posts: Int = 0,
    val comments: Int = 0,
    val chunks: Int = 0,
    val newestPost: String = "",
    val oldestPost: String = "",
    val builtAt: String = "",
    val semantic: Boolean = false,
)

@Serializable
data class Suggestion(val topic: String = "", val question: String = "")

@Serializable
data class TopicCount(val id: String, val label: String = "", val emoji: String = "", val count: Int = 0)

@Serializable
data class CourseCount(val code: String, val count: Int = 0, val department: String = "", val latest: String = "")

@Serializable
data class HomePayload(
    val stats: Stats = Stats(),
    val suggestions: List<Suggestion> = emptyList(),
    val trending: List<PostSummary> = emptyList(),
    val latest: List<PostSummary> = emptyList(),
    val topics: List<TopicCount> = emptyList(),
    val courses: List<CourseCount> = emptyList(),
)

@Serializable
data class SearchResult(
    val total: Int = 0,
    val page: Int = 1,
    val pageSize: Int = 20,
    val sort: String = "",
    val dense: Boolean = false,
    val terms: List<String> = emptyList(),
    val results: List<PostSummary> = emptyList(),
)

@Serializable
data class CourseList(val total: Int = 0, val courses: List<CourseCount> = emptyList())

@Serializable
data class CoursePosts(val code: String = "", val total: Int = 0, val posts: List<PostSummary> = emptyList())

@Serializable
data class ChatTurn(val role: String, val content: String)

@Serializable
data class AskBody(val question: String, val history: List<ChatTurn>, val stream: Boolean = true)

@Serializable
data class GeminiHealth(val configured: Boolean = false, val chatModel: String = "")

@Serializable
data class ArchiveHealth(val source: String = "", val posts: Int = 0, val comments: Int = 0, val vectors: Boolean = false)

@Serializable
data class Health(
    val ok: Boolean = false,
    val accessCode: Boolean = false,
    val gemini: GeminiHealth = GeminiHealth(),
    val archive: ArchiveHealth = ArchiveHealth(),
)

@Serializable
data class ApiErrorBody(val error: String = "", val message: String = "")

/** Human-readable topic labels, mirroring the backend's ids. */
val TopicLabels: Map<String, String> = mapOf(
    "courses" to "📚 Courses",
    "professors" to "🎓 Professors",
    "study-away" to "✈️ Study away",
    "housing" to "🏠 Housing",
    "visa-travel" to "🛂 Visa & travel",
    "jobs" to "💼 Jobs",
    "money" to "💸 Money",
    "marketplace" to "🛒 Buy & sell",
    "food" to "🍽️ Food",
    "health" to "🩺 Health",
    "transport" to "🚌 Transport",
    "tech" to "💻 Tech",
    "events" to "🎉 Events",
    "research" to "🔬 Research",
    "lost-found" to "🔎 Lost & found",
    "grad-school" to "🎯 Grad school",
)

fun topicLabel(id: String): String = TopicLabels[id] ?: id

private val Months = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/** "2026-04-01" → "1 Apr 2026"; anything else is passed through. */
fun formatDate(date: String): String {
    val match = Regex("^(\\d{4})-(\\d{2})-(\\d{2})").find(date) ?: return date.ifBlank { "undated" }
    val (year, month, day) = match.destructured
    val name = Months.getOrNull(month.toInt() - 1) ?: return date
    return "${day.toInt()} $name $year"
}

fun compact(n: Int): String = if (n >= 1000) "${n / 1000}.${(n % 1000) / 100}k" else n.toString()
