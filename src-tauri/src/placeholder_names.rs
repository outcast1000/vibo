//! Album titles and artist names that stand in for a missing tag.
//!
//! Navidrome files untagged tracks under `[Unknown Album]`, one per artist, and
//! `[Unknown Artist]`; other servers and taggers use similar spellings
//! ("Unknown Album", "<Unknown>", "No Album"). They name nothing, so:
//!
//! - **Ingest drops them** — the scanner (`Database::ingest_scanned_files`),
//!   the Subsonic sync and plugin-collection sync treat a placeholder exactly
//!   like a missing tag (no album row, no artist row), which is what a local
//!   file with no tag already gets. Kept as rows they became one fake album per
//!   artist, grouped unrelated songs under Play Full Album, and were sent to
//!   scrobblers and metadata lookups as if they were names.
//! - **Image lookups skip the plugin providers** for one (`lib.rs`
//!   `resolve_entity_image`): searching a catalog for a placeholder returns
//!   somebody else's record — before this, one stock photo became the cover of
//!   216 Navidrome `[Unknown Album]`s.
//!
//! Matched loosely (case, brackets and punctuation ignored) but only on the
//! "unknown" family, because short or generic titles ("Untitled", "Album") are
//! real albums. "Various Artists" is deliberately not a placeholder: it is a
//! real album owner.

/// Is this album title a stand-in for "no album tag" rather than a name?
pub fn is_placeholder_album_title(title: &str) -> bool {
    matches!(fold(title).as_str(), "" | "unknown" | "unknownalbum" | "noalbum")
}

/// Is this artist name a stand-in for "no artist tag" (`[Unknown Artist]`)?
pub fn is_placeholder_artist_name(name: &str) -> bool {
    matches!(fold(name).as_str(), "" | "unknown" | "unknownartist" | "noartist")
}

/// The album title, or `None` when there is none or it is a placeholder.
pub fn real_album_title(title: Option<&str>) -> Option<&str> {
    title.filter(|t| !is_placeholder_album_title(t))
}

/// The artist name, or `None` when there is none or it is a placeholder.
pub fn real_artist_name(name: Option<&str>) -> Option<&str> {
    name.filter(|n| !is_placeholder_artist_name(n))
}

fn fold(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_placeholder_album_titles_are_recognised() {
        for title in ["[Unknown Album]", "Unknown Album", "unknown", "<Unknown>", "[unknown]", "No Album", "", "  "] {
            assert!(is_placeholder_album_title(title), "{title:?} should be a placeholder");
        }
    }

    #[test]
    fn test_real_album_titles_are_not_placeholders() {
        for title in ["Untitled", "Album", "Unknown Pleasures", "The Unknown", "Blackstar"] {
            assert!(!is_placeholder_album_title(title), "{title:?} is a real title");
        }
    }

    #[test]
    fn test_placeholder_artist_names_are_recognised() {
        for name in ["[Unknown Artist]", "Unknown Artist", "Unknown", "<unknown>", "No Artist", ""] {
            assert!(is_placeholder_artist_name(name), "{name:?} should be a placeholder");
        }
        for name in ["Various Artists", "The Unknown", "Unknown Mortal Orchestra", "Artist"] {
            assert!(!is_placeholder_artist_name(name), "{name:?} is a real name");
        }
    }

    #[test]
    fn test_option_filters_drop_only_placeholders() {
        assert_eq!(real_album_title(Some("[Unknown Album]")), None);
        assert_eq!(real_album_title(Some("Blackstar")), Some("Blackstar"));
        assert_eq!(real_album_title(None), None);
        assert_eq!(real_artist_name(Some("[Unknown Artist]")), None);
        assert_eq!(real_artist_name(Some("Various Artists")), Some("Various Artists"));
    }
}
