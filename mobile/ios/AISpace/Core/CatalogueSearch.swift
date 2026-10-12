import Foundation

/// The library's search rule (docs/panel.md#screens): every word of the query must appear in
/// the entry's title, description or id. All of an entry's languages are searched, so "todo"
/// and "待办" find the same app whichever language the phone shows.
enum CatalogueSearch {
    static func fold(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
    }

    static func haystack(_ e: CatalogueEntry) -> String {
        var parts = [e.title, e.ref, e.detail ?? ""]
        for text in (e.i18n ?? [:]).values {
            parts.append(text.title ?? "")
            parts.append(text.description ?? "")
        }
        return fold(parts.joined(separator: "\n"))
    }

    static func matches(_ e: CatalogueEntry, query: String) -> Bool {
        let words = fold(query).split(whereSeparator: \.isWhitespace)
        if words.isEmpty { return true }
        let text = haystack(e)
        return words.allSatisfy { text.contains($0) }
    }

    static func filter(_ entries: [CatalogueEntry], query: String) -> [CatalogueEntry] {
        entries.filter { matches($0, query: query) }
    }
}
