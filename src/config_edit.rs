//! The config write behind `filing save`: replace only the `folders`/`owners` value spans
//! under `[classify]`, keep every comment and every other byte, then rename a fresh file
//! into place (atomic on one filesystem). `toml`'s deserializer gives byte spans through
//! `DeTable`, so the edit is `String::replace_range` on offsets - last span first, so the
//! earlier offsets stay valid. Anything this cannot do without risk (a comment inside the
//! old array, an inline or dotted `classify`) is refused with a clear message instead of
//! guessed at: the user can always edit `config.toml` by hand.

use std::fs::OpenOptions;
use std::io::{ErrorKind, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process;

use anyhow::{Context, anyhow};
use toml::de::DeTable;

use crate::config::Config;

/// Wrap quoted names like `config.example.toml`: `[` header, two-space indent, items
/// joined with ", " up to ~100 characters per line, a trailing comma, `]` alone.
fn render(list: &[String]) -> String {
    if list.is_empty() {
        return "[]".to_string();
    }

    let quoted: Vec<String> = list
        .iter()
        .map(|name| format!("\"{name}\"", name = name).to_string())
        .collect();

    let mut lines: Vec<String> = Vec::new();
    let mut line: Vec<String> = Vec::new();
    let width: usize = 100;
    let mut line_len: usize = 2;

    for item in quoted.iter() {
        if !line.is_empty() && line_len + 2 + item.len() > width {
            lines.push("  ".to_string() + line.join(", ").as_str());
            line.clear();
            line_len = 2;
        }
        if !line.is_empty() {
            line_len += 2;
        }
        line.push(item.to_string());
        line_len += item.len();
    }
    if !line.is_empty() {
        lines.push("  ".to_string() + line.join(", ").as_str());
    }

    let joined = lines.join(",\n");
    let result: String = "[\n".to_string() + joined.as_str() + ",\n]";
    result
}

/// Rewrite `text` with the requested lists and report whether the bytes change.
/// `Err` is a refusal (unparseable config, inline/dotted `classify`, a comment inside
/// the old array, a verification mismatch) - never a partial edit.
pub(crate) fn patch_file(
    text: String,
    folders: &[String],
    owners: &[String],
    shared_owner: Option<&str>,
) -> anyhow::Result<(String, bool)> {
    let parsed = DeTable::parse(text.as_str())
        .context("the config file is not valid TOML: edit it by hand")?;
    let root = parsed.get_ref();

    let mut new_text = text.to_string();
    let mut classify_found = false;
    let mut edits: Vec<(usize, usize, String)> = Vec::new();

    for (key, value) in root.iter() {
        let name = key.get_ref().as_ref();
        if name != "classify" {
            continue;
        }

        classify_found = true;
        let value_span = value.span();
        let slice = &text[value_span.start..value_span.end];
        if slice.trim_start().starts_with("{") {
            return Err(anyhow!(
                "`classify` is an inline table: edit config.toml by hand"
            ));
        }

        let table = value.get_ref().as_table();
        if table.is_none() {
            return Err(anyhow!(
                "`classify` is not a table: edit config.toml by hand"
            ));
        }
        let classify_table = table.unwrap();

        for (child_key, _) in classify_table.iter() {
            let child_start = child_key.span().start;
            if child_start > 0 && text[..child_start].trim_end().ends_with(".") {
                return Err(anyhow!(
                    "`classify` uses dotted keys: edit config.toml by hand"
                ));
            }
        }

        let header_start = key.span().start;
        let insert_at: usize = match text[header_start..].find("\n") {
            Some(offset) => header_start + offset,
            None => text.len(),
        };

        let mut have_folders = false;
        let mut have_owners = false;
        let mut have_shared = false;

        for (child_key, child_value) in classify_table.iter() {
            let child = child_key.get_ref().as_ref();
            if child == "folders" {
                have_folders = true;
                let old_span = child_value.span();
                if !child_value.get_ref().is_array() {
                    return Err(anyhow!(
                        "`folders` is not an array: edit config.toml by hand"
                    ));
                }
                if text[old_span.start..old_span.end].contains("#") {
                    return Err(anyhow!(
                        "the `folders` list has a comment inside it: edit config.toml by hand"
                    ));
                }
                edits.push((old_span.start, old_span.end, render(folders)));
            } else if child == "owners" {
                have_owners = true;
                let old_span = child_value.span();
                if !child_value.get_ref().is_array() {
                    return Err(anyhow!(
                        "`owners` is not an array: edit config.toml by hand"
                    ));
                }
                if text[old_span.start..old_span.end].contains("#") {
                    return Err(anyhow!(
                        "the `owners` list has a comment inside it: edit config.toml by hand"
                    ));
                }
                edits.push((old_span.start, old_span.end, render(owners)));
            } else if child == "shared_owner" {
                have_shared = true;
                let old_span = child_value.span();
                let raw: String = text[old_span.start..old_span.end].to_string();
                // A TOML string starts with a quote; anything else (a number, an array) is not
                // ours to rewrite.
                if !(raw.starts_with("\"") || raw.starts_with("'")) {
                    return Err(anyhow!(
                        "`shared_owner` is not a string: edit config.toml by hand"
                    ));
                }
                if let Some(value) = shared_owner {
                    edits.push((old_span.start, old_span.end, format!("\"{value}\"")));
                }
            }
        }

        let mut insert = "".to_string();
        if !have_folders {
            insert += format!("\nfolders = {list}", list = render(folders)).as_str();
        }
        if !have_owners {
            insert += format!("\nowners = {list}", list = render(owners)).as_str();
        }
        // The shared owner is inserted only when the draft actually renames it (the caller
        // passes `Some` only for a name that differs from the effective one), and only where
        // the key is absent. A key present with the same value needs no edit at all.
        if let (Some(value), false) = (shared_owner, have_shared) {
            insert += format!("\nshared_owner = \"{value}\"").as_str();
        }
        if !insert.is_empty() {
            edits.push((insert_at, insert_at, insert.to_string()));
        }
    }

    if !classify_found {
        let sep = if text.is_empty() || text.ends_with("\n") {
            ""
        } else {
            "\n"
        };
        let shared_line: String = if let Some(value) = shared_owner {
            format!("shared_owner = \"{value}\"\n")
        } else {
            String::new()
        };
        let section = format!(
            "{sep}[classify]\nfolders = {f}\nowners = {o}\n{shared_line}",
            f = render(folders),
            o = render(owners),
        )
        .to_string();
        edits.push((text.len(), text.len(), section.to_string()));
    }

    edits.sort_by_key(|left| std::cmp::Reverse(left.0));
    for (start, end, replacement) in edits {
        new_text.replace_range(start..end, replacement.as_str());
    }

    let result: Config =
        toml::from_str(new_text.as_str()).context("the rewritten config does not parse")?;
    if result.classify.folders != folders.to_vec() || result.classify.owners != owners.to_vec() {
        return Err(anyhow!(
            "the rewritten config did not hold exactly the requested lists"
        ));
    }
    match (shared_owner, result.classify.shared_owner) {
        (Some(value), stored) if stored != value => {
            return Err(anyhow!(
                "the rewritten config did not hold exactly the requested shared owner"
            ));
        }
        _ => {}
    }

    let changed = new_text != text;
    Ok((new_text, changed))
}

/// Write the two lists (and, when the draft renames it, the shared owner) to `path`, keeping
/// comments and everything else byte-identical (via `patch_file`). Returns whether the bytes
/// changed (`false`: already as asked, nothing written). A missing file is an empty base:
/// the section is created.
pub(crate) fn write_lists(
    path: &Path,
    folders: &[String],
    owners: &[String],
    shared_owner: Option<&str>,
) -> anyhow::Result<bool> {
    let old: String = match std::fs::read_to_string(path.as_os_str()) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => "".to_string(),
        Err(e) => return Err(e).context(format!("cannot read {}", path.display()).to_string()),
    };
    let (new, changed) = patch_file(old.to_string(), folders, owners, shared_owner)?;
    if !changed {
        return Ok(false);
    }

    let dir: &Path = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    if let Err(e) = std::fs::create_dir_all(dir.as_os_str()) {
        return Err(e).context(format!("cannot create {}", dir.display()).to_string());
    }

    let mode: u32 = match path.metadata() {
        Ok(meta) => meta.mode() & 0o7777,
        Err(e) if e.kind() == ErrorKind::NotFound => 0o600,
        Err(e) => {
            return Err(e)
                .context(format!("cannot read permissions for {}", path.display()).to_string());
        }
    };

    let name: String = match path.file_name() {
        Some(n) => n.to_string_lossy().to_string(),
        None => "config.toml".to_string(),
    };
    let stamp = process::id().to_string();

    for attempt in 0..100 {
        let temp_name: String =
            format!(".{name}.tmp-{stamp}-{attempt}", name = name, stamp = stamp).to_string();
        let temp: PathBuf = dir.join(temp_name.as_str());
        let mut options = OpenOptions::new();
        options.create_new(true);
        options.write(true);
        options.mode(mode);

        let mut file = match options.open(temp.as_os_str()) {
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e).context("cannot create temporary config file"),
            Ok(file) => file,
        };

        if let Err(e) = file.write_all(new.as_bytes()) {
            _ = std::fs::remove_file(temp.as_os_str());
            return Err(e).context("cannot write temporary config file");
        }
        if let Err(e) = file.flush() {
            _ = std::fs::remove_file(temp.as_os_str());
            return Err(e).context("cannot flush temporary config file");
        }
        if let Err(e) = std::fs::rename(temp.as_os_str(), path.as_os_str()) {
            _ = std::fs::remove_file(temp.as_os_str());
            return Err(e).context("cannot replace config file");
        }
        return Ok(true);
    }

    Err(anyhow!("could not create a temporary config file"))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{patch_file, render, write_lists};

    #[test]
    fn render_matches_the_example_shape() {
        let empty: Vec<String> = vec![];
        let one: Vec<String> = vec!["One".to_string()];
        let two: Vec<String> = vec!["One".to_string(), "Two".to_string()];
        assert_eq!(render(&empty), "[]");
        assert_eq!(render(&one), "[\n  \"One\",\n]");
        assert_eq!(render(&two), "[\n  \"One\", \"Two\",\n]");
    }

    #[test]
    fn patch_keeps_comments_and_other_sections() {
        let before: String = "[qdrant]\ncollection = \"docs\" # keep me\n\n[classify]\n# folder comment\nfolders = [\"Old\",]\n".to_string();
        let folders: Vec<String> = vec!["New".to_string()];
        let owners: Vec<String> = vec![];
        let (after, changed) = patch_file(before, &folders, &owners, None).unwrap();
        assert!(changed);
        assert!(after.contains("collection = \"docs\" # keep me"));
        assert!(after.contains("# folder comment"));
        assert!(after.contains("folders = ["));
        assert!(after.contains("\"New\""));
        assert!(!after.contains("\"Old\""));
    }

    #[test]
    fn patch_inserts_missing_keys_after_the_header() {
        let before: String = "[classify]\n# hi\n".to_string();
        let folders: Vec<String> = vec!["One".to_string()];
        let owners: Vec<String> = vec!["Two".to_string()];
        let (after, changed) = patch_file(before, &folders, &owners, None).unwrap();
        assert!(changed);
        assert!(after.contains("# hi"));
        assert!(after.contains("folders = ["));
        assert!(after.contains("owners = ["));
    }

    #[test]
    fn patch_appends_section_when_classify_is_absent() {
        let before: String = "# only comment\n".to_string();
        let folders: Vec<String> = vec!["One".to_string()];
        let owners: Vec<String> = vec!["Two".to_string()];
        let (after, changed) = patch_file(before, &folders, &owners, None).unwrap();
        assert!(changed);
        assert!(
            after.contains("\n[classify]\nfolders = [\n  \"One\",\n]\nowners = [\n  \"Two\",\n]\n")
        );
    }

    #[test]
    fn patch_refuses_unsupported_shapes() {
        let y: Vec<String> = vec!["y".to_string()];
        let none: Vec<String> = vec![];
        assert!(
            patch_file(
                "classify = { folders = [\"x\"] }".to_string(),
                &y,
                &none,
                None
            )
            .unwrap_err()
            .to_string()
            .contains("inline")
        );
        assert!(
            patch_file("classify.folders = [\"x\"]".to_string(), &y, &none, None)
                .unwrap_err()
                .to_string()
                .contains("dotted")
        );
        assert!(
            patch_file(
                "[classify]\nfolders = [\n  \"x\", # keep me\n]\n".to_string(),
                &y,
                &none,
                None,
            )
            .unwrap_err()
            .to_string()
            .contains("comment")
        );
    }

    #[test]
    fn patch_replaces_shared_owner_span() {
        let before: String = "[classify]\nshared_owner = \"Shared\"\n".to_string();
        let folders: Vec<String> = vec!["One".to_string()];
        let owners: Vec<String> = vec![];
        let everyone: String = "Everyone".to_string();
        let (after, changed) =
            patch_file(before, &folders, &owners, Some(everyone.as_str())).unwrap();
        assert!(changed);
        assert!(after.contains("shared_owner = \"Everyone\""));
        assert!(!after.contains("shared_owner = \"Shared\""));
    }

    #[test]
    fn patch_inserts_shared_owner_under_classify() {
        let before: String = "[classify]\nfolders = [\"One\"]\n".to_string();
        let folders: Vec<String> = vec!["One".to_string()];
        let owners: Vec<String> = vec![];
        let everyone: String = "Everyone".to_string();
        let (after, changed) =
            patch_file(before, &folders, &owners, Some(everyone.as_str())).unwrap();
        assert!(changed);
        assert!(after.contains("shared_owner = \"Everyone\""));
    }

    #[test]
    fn patch_refuses_a_shared_owner_that_is_not_a_string() {
        let y: Vec<String> = vec!["y".to_string()];
        let none: Vec<String> = vec![];
        let everyone: String = "Everyone".to_string();
        assert!(
            patch_file(
                "[classify]\nshared_owner = 7\n".to_string(),
                &y,
                &none,
                Some(everyone.as_str())
            )
            .unwrap_err()
            .to_string()
            .contains("shared_owner")
        );
    }

    #[test]
    fn patch_is_idempotent_for_shared_owner() {
        let before: String =
            "[classify]\nfolders = []\nowners = []\nshared_owner = \"Everyone\"\n".to_string();
        let folders: Vec<String> = vec![];
        let owners: Vec<String> = vec![];
        let everyone: String = "Everyone".to_string();
        let (_, changed) = patch_file(before, &folders, &owners, Some(everyone.as_str())).unwrap();
        assert!(!changed);
    }

    #[test]
    fn write_lists_roundtrip_keeps_other_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.toml");
        fs::write(&file, "[classify]\nfolders = [\"Old\"]\n").unwrap();
        let before = fs::read_to_string(file.as_os_str()).unwrap();

        let folders: Vec<String> = vec!["New".to_string()];
        let owners: Vec<String> = vec!["Alex Example".to_string()];
        let changed = write_lists(&file, &folders, &owners, None).unwrap();
        assert!(changed);

        let after = fs::read_to_string(file.as_os_str()).unwrap();
        assert!(after.contains("[classify]"));
        assert!(after.contains("folders = ["));
        assert!(after.contains("\"New\""));
        assert!(after.contains("owners = ["));
        assert!(after.contains("\"Alex Example\""));
        assert_ne!(after, before);
    }

    #[test]
    fn write_lists_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.toml");
        fs::write(
            &file,
            "[classify]\nfolders = [\"One\"]\nowners = [\"Two\"]\n",
        )
        .unwrap();
        let folders: Vec<String> = vec!["One".to_string()];
        let owners: Vec<String> = vec!["Two".to_string()];
        let first = write_lists(&file, &folders, &owners, None).unwrap();
        assert!(first);

        let after_first = fs::read_to_string(file.as_os_str()).unwrap();
        let second = write_lists(&file, &folders, &owners, None).unwrap();
        assert!(!second);
        assert_eq!(fs::read_to_string(file.as_os_str()).unwrap(), after_first);
    }
}
