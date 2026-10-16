import Foundation

/// The Home command box's rules (docs/panel.md#omnibox), as the web panel's `src/web/omnibox.ts`:
/// how well an entry's name fits the query, and whether Return opens the best match or asks
/// Space Assistant. Keep the two in step.
enum OmniboxRules {
    /// A name that equals the query, starts with it, has a word starting with it, or holds it; else a match elsewhere.
    enum Score {
        static let exact = 100
        static let prefix = 80
        static let word = 60
        static let inside = 50
        static let text = 10
    }

    /// At or above this, the best match is a name the operator typed: Return opens it.
    static let openScore = Score.inside

    /// The entry's titles in every language and its layout id.
    static func names(_ e: CatalogueEntry) -> [String] {
        [e.title] + (e.i18n ?? [:]).values.compactMap(\.title) + [e.ref]
    }

    /// 0 when the library search would not show the entry; more the better a name fits.
    static func score(_ query: String, _ e: CatalogueEntry) -> Int {
        let q = CatalogueSearch.fold(query.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !q.isEmpty, CatalogueSearch.matches(e, query: q) else { return 0 }
        var best = Score.text
        for raw in names(e) {
            let name = CatalogueSearch.fold(raw)
            if name == q { return Score.exact }
            if name.hasPrefix(q) {
                best = max(best, Score.prefix)
            } else if name.split(whereSeparator: { " -_/·.".contains($0) || $0.isWhitespace }).contains(where: { $0.hasPrefix(q) }) {
                best = max(best, Score.word)
            } else if name.contains(q) {
                best = max(best, Score.inside)
            }
        }
        return best
    }

    /// The matching entries, best first; equal scores keep the given order.
    static func rank(_ query: String, _ entries: [CatalogueEntry]) -> [CatalogueEntry] {
        let scored: [(index: Int, score: Int)] = entries.indices.map { ($0, score(query, entries[$0])) }
        let kept = scored.filter { $0.score > 0 }
        let ordered = kept.sorted { a, b in a.score != b.score ? a.score > b.score : a.index < b.index }
        return ordered.map { entries[$0.index] }
    }

    /// Return opens the best match when its name holds the whole query; anything else is a question.
    static func opensByDefault(_ query: String, _ first: CatalogueEntry?) -> Bool {
        guard let first else { return false }
        return score(query, first) >= openScore
    }
}
