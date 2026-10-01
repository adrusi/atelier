//! UserCSS (SPEC §5.3): the `==UserStyle==` format used by Stylus.
//!
//! A UserCSS file is a metadata comment followed by CSS. Code inside
//! `@-moz-document` blocks applies to the URLs those blocks name; code outside
//! them is "global" and applies everywhere, as in Stylus. Only the `default`
//! preprocessor is supported: each `@var` becomes a `--name` custom property.

use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub struct UserStyle {
    pub meta: Meta,
    pub sections: Vec<Section>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Meta {
    pub name: Option<String>,
    pub namespace: Option<String>,
    pub version: Option<String>,
    pub description: Option<String>,
    pub preprocessor: Option<String>,
    pub vars: Vec<Var>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Var {
    pub kind: VarKind,
    pub name: String,
    pub label: String,
    /// The default value, as it should appear in CSS (units included).
    pub default: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VarKind {
    Color,
    Text,
    Number,
    Range,
    Checkbox,
    Select,
}

/// A run of CSS and the URLs it applies to. No matchers means global.
#[derive(Debug, Clone, PartialEq)]
pub struct Section {
    pub matchers: Vec<Matcher>,
    pub css: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Matcher {
    /// `url(...)`: the whole URL, ignoring any fragment.
    Url(String),
    /// `url-prefix(...)`: URLs starting with this.
    UrlPrefix(String),
    /// `domain(...)`: this host or any subdomain of it.
    Domain(String),
    /// `regexp(...)`: a JavaScript regular expression that must match the whole URL.
    Regexp(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub message: String,
    /// 1-based line of the problem, where known.
    pub line: Option<usize>,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.line {
            Some(line) => write!(f, "line {line}: {}", self.message),
            None => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for ParseError {}

fn error(source: &str, at: usize, message: impl Into<String>) -> ParseError {
    ParseError {
        message: message.into(),
        line: Some(source[..at.min(source.len())].matches('\n').count() + 1),
    }
}

pub fn parse(source: &str) -> Result<UserStyle, ParseError> {
    let (meta, meta_range) = parse_meta(source)?;
    if let Some(p) = &meta.preprocessor
        && p != "default"
    {
        return Err(ParseError {
            message: format!("preprocessor `{p}` isn't supported; only `default` is"),
            line: None,
        });
    }

    let mut sections = Vec::new();
    let mut global = String::new();
    let mut scanner = Scanner::new(source);
    let mut copied_to = 0;

    while let Some(at) = scanner.next_top_level_at_rule() {
        let keyword_end = at
            + scanner
                .rest_from(at)
                .find(['(', ' ', '\t', '\n', '{'])
                .unwrap_or(0);
        let keyword = source[at..keyword_end].to_ascii_lowercase();
        if keyword != "@-moz-document" && keyword != "@document" {
            continue;
        }
        let open = scanner
            .find_top_level_brace(keyword_end)
            .ok_or_else(|| error(source, at, "`@-moz-document` without a `{` block"))?;
        let close = scanner
            .find_matching_brace(open)
            .ok_or_else(|| error(source, open, "unclosed `@-moz-document` block"))?;
        let matchers = parse_matchers(&source[keyword_end..open])
            .map_err(|m| error(source, keyword_end, m))?;
        if matchers.is_empty() {
            return Err(error(source, at, "`@-moz-document` with no URL matchers"));
        }

        global.push_str(&strip_range(source, copied_to, at, &meta_range));
        sections.push(Section {
            matchers,
            css: source[open + 1..close].trim().to_string(),
        });
        copied_to = close + 1;
        scanner.seek(close + 1);
    }
    global.push_str(&strip_range(source, copied_to, source.len(), &meta_range));

    if !is_blank_css(&global) {
        sections.insert(
            0,
            Section {
                matchers: Vec::new(),
                css: global.trim().to_string(),
            },
        );
    }
    Ok(UserStyle { meta, sections })
}

/// `source[from..to]`, minus the metadata comment if it falls inside.
fn strip_range(source: &str, from: usize, to: usize, meta: &Option<(usize, usize)>) -> String {
    match meta {
        Some((m0, m1)) if *m0 >= from && *m1 <= to => {
            format!("{}{}", &source[from..*m0], &source[*m1..to])
        }
        _ => source[from..to].to_string(),
    }
}

/// True if `css` contains nothing but whitespace and comments.
fn is_blank_css(css: &str) -> bool {
    let mut rest = css.trim_start();
    while let Some(after) = rest.strip_prefix("/*") {
        match after.find("*/") {
            Some(end) => rest = after[end + 2..].trim_start(),
            None => return true,
        }
    }
    rest.is_empty()
}

// ---------------------------------------------------------------------------
// Metadata

fn parse_meta(source: &str) -> Result<(Meta, Option<(usize, usize)>), ParseError> {
    let Some(start) = source.find("==UserStyle==") else {
        return Ok((Meta::default(), None));
    };
    let comment_start = source[..start]
        .rfind("/*")
        .ok_or_else(|| error(source, start, "`==UserStyle==` outside a comment"))?;
    let end_marker = source[start..]
        .find("==/UserStyle==")
        .map(|i| start + i)
        .ok_or_else(|| error(source, start, "`==UserStyle==` without `==/UserStyle==`"))?;
    let comment_end = source[end_marker..]
        .find("*/")
        .map(|i| end_marker + i + 2)
        .ok_or_else(|| error(source, end_marker, "unterminated metadata comment"))?;

    let body = &source[start + "==UserStyle==".len()..end_marker];
    let body_offset = start + "==UserStyle==".len();
    let mut meta = Meta::default();
    let mut lines = LineCursor::new(body);
    while let Some((offset, line)) = lines.next() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix('@') else {
            continue;
        };
        let (key, value) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
        let value = value.trim();
        match key {
            "name" => meta.name = Some(value.to_string()),
            "namespace" => meta.namespace = Some(value.to_string()),
            "version" => meta.version = Some(value.to_string()),
            "description" => meta.description = Some(value.to_string()),
            "preprocessor" => meta.preprocessor = Some(value.to_string()),
            "var" | "advanced" => {
                // Select and range defaults may be bracketed and span lines.
                let mut value = value.to_string();
                while !brackets_balanced(&value) {
                    match lines.next() {
                        Some((_, more)) => {
                            value.push('\n');
                            value.push_str(more);
                        }
                        None => {
                            return Err(error(
                                source,
                                body_offset + offset,
                                "unclosed bracket in `@var`",
                            ));
                        }
                    }
                }
                meta.vars
                    .push(parse_var(&value).map_err(|m| error(source, body_offset + offset, m))?);
            }
            _ => {}
        }
    }
    Ok((meta, Some((comment_start, comment_end))))
}

struct LineCursor<'a> {
    text: &'a str,
    pos: usize,
}

impl<'a> LineCursor<'a> {
    fn new(text: &'a str) -> Self {
        LineCursor { text, pos: 0 }
    }

    fn next(&mut self) -> Option<(usize, &'a str)> {
        if self.pos >= self.text.len() {
            return None;
        }
        let start = self.pos;
        let end = self.text[start..]
            .find('\n')
            .map_or(self.text.len(), |i| start + i);
        self.pos = end + 1;
        Some((start, &self.text[start..end]))
    }
}

fn brackets_balanced(s: &str) -> bool {
    let mut depth = 0i32;
    let mut quote = None;
    let mut escaped = false;
    for c in s.chars() {
        if let Some(q) = quote {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => quote = Some(c),
            '{' | '[' => depth += 1,
            '}' | ']' => depth -= 1,
            _ => {}
        }
    }
    depth <= 0
}

/// Parses the part of a `@var` line after `@var`: `<type> <name> <label> <default>`.
fn parse_var(spec: &str) -> Result<Var, String> {
    let (kind, rest) = take_word(spec).ok_or("`@var` without a type")?;
    let kind = match kind {
        "color" => VarKind::Color,
        "text" => VarKind::Text,
        "number" => VarKind::Number,
        "range" => VarKind::Range,
        "checkbox" => VarKind::Checkbox,
        "select" | "dropdown" | "image" => VarKind::Select,
        other => return Err(format!("unknown `@var` type `{other}`")),
    };
    let (name, rest) = take_word(rest).ok_or("`@var` without a name")?;
    let (label, rest) = take_label(rest).ok_or("`@var` without a label")?;
    let raw = rest.trim();
    let default = match kind {
        VarKind::Color | VarKind::Text => raw.to_string(),
        VarKind::Checkbox => match raw {
            "0" | "1" => raw.to_string(),
            _ => return Err(format!("checkbox `{name}` default must be 0 or 1")),
        },
        VarKind::Number | VarKind::Range => {
            numeric_default(raw).map_err(|e| format!("`{name}`: {e}"))?
        }
        VarKind::Select => select_default(raw).map_err(|e| format!("`{name}`: {e}"))?,
    };
    Ok(Var {
        kind,
        name: name.to_string(),
        label,
        default,
    })
}

fn take_word(s: &str) -> Option<(&str, &str)> {
    let s = s.trim_start();
    if s.is_empty() {
        return None;
    }
    let end = s.find(char::is_whitespace).unwrap_or(s.len());
    Some((&s[..end], &s[end..]))
}

fn take_label(s: &str) -> Option<(String, &str)> {
    let s = s.trim_start();
    let q = s.chars().next()?;
    if q == '"' || q == '\'' {
        let end = s[1..].find(q)? + 1;
        Some((s[1..end].to_string(), &s[end + 1..]))
    } else {
        take_word(s).map(|(w, r)| (w.to_string(), r))
    }
}

/// `8`, `8px`, or the array form `[default, min, max, step, unit]`.
fn numeric_default(raw: &str) -> Result<String, String> {
    if !raw.starts_with('[') {
        return Ok(raw.to_string());
    }
    let items: Vec<serde_json::Value> =
        serde_json::from_str(raw).map_err(|e| format!("bad range/number default: {e}"))?;
    let value = items.first().ok_or("empty range/number default")?;
    let unit = items.get(4).and_then(|u| u.as_str()).unwrap_or("");
    let number = match value {
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => s.clone(),
        _ => return Err("range/number default must be a number".into()),
    };
    Ok(format!("{number}{unit}"))
}

/// The CSS value of a select's default option, following usercss-meta (the
/// parser Stylus uses). Options are an array of strings or an object mapping
/// keys to CSS values. A key ending in `*` marks the default; otherwise the
/// first option is the default. A key may be `name:label` (name is `\w+`).
/// In the array form, an option's CSS value is its name.
fn select_default(raw: &str) -> Result<String, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("bad select options: {e}"))?;
    let entries: Vec<(String, Option<String>)> = match parsed {
        serde_json::Value::Array(items) => items
            .into_iter()
            .map(|i| match i {
                serde_json::Value::String(s) => Ok((s, None)),
                _ => Err("select options must be strings".to_string()),
            })
            .collect::<Result<_, _>>()?,
        serde_json::Value::Object(map) => map
            .into_iter()
            .map(|(k, v)| match v {
                serde_json::Value::String(s) => Ok((k, Some(s))),
                _ => Err("select values must be strings".to_string()),
            })
            .collect::<Result<_, _>>()?,
        _ => return Err("select options must be an array or object".into()),
    };

    let name_label = regex::Regex::new(r"^(\w+):(.*)").expect("static regex");
    let mut first = None;
    let mut default = None;
    for (key, value) in entries {
        let (key, is_default) = match key.strip_suffix('*') {
            Some(k) => (k.to_string(), true),
            None => (key, false),
        };
        let name = name_label
            .captures(&key)
            .map_or(key.clone(), |c| c[1].to_string());
        let css = value.unwrap_or(name);
        if is_default {
            if default.is_some() {
                return Err("select has more than one default".into());
            }
            default = Some(css.clone());
        }
        first.get_or_insert(css);
    }
    default
        .or(first)
        .ok_or_else(|| "select with no options".into())
}

// ---------------------------------------------------------------------------
// @-moz-document

fn parse_matchers(prelude: &str) -> Result<Vec<Matcher>, String> {
    let mut matchers = Vec::new();
    let mut rest = prelude.trim();
    while !rest.is_empty() {
        let paren = rest
            .find('(')
            .ok_or_else(|| format!("expected a matcher function at `{rest}`"))?;
        let name = rest[..paren].trim().to_ascii_lowercase();
        let (arg, after) = read_function_arg(&rest[paren + 1..])?;
        matchers.push(match name.as_str() {
            "url" => Matcher::Url(arg),
            "url-prefix" => Matcher::UrlPrefix(arg),
            "domain" => Matcher::Domain(arg),
            "regexp" => Matcher::Regexp(arg),
            other => return Err(format!("unknown `@-moz-document` matcher `{other}`")),
        });
        rest = after.trim_start();
        if let Some(r) = rest.strip_prefix(',') {
            rest = r.trim_start();
        } else if !rest.is_empty() {
            return Err(format!("expected `,` between matchers at `{rest}`"));
        }
    }
    Ok(matchers)
}

/// Reads a function argument up to its closing `)`: a CSS string, or an
/// unquoted value as `url()` allows. Returns the value and what follows `)`.
fn read_function_arg(s: &str) -> Result<(String, &str), String> {
    let s = s.trim_start();
    match s.chars().next() {
        Some(q @ ('"' | '\'')) => {
            let (value, len) =
                read_css_string(&s[1..], q).ok_or("unterminated string in matcher")?;
            let after = s[1 + len..].trim_start();
            let after = after
                .strip_prefix(')')
                .ok_or("expected `)` after matcher string")?;
            Ok((value, after))
        }
        _ => {
            let close = s.find(')').ok_or("unclosed matcher function")?;
            Ok((s[..close].trim().to_string(), &s[close + 1..]))
        }
    }
}

/// Decodes a CSS string body (after the opening quote) up to the closing
/// `quote`. Returns the value and the number of bytes consumed, including the
/// closing quote.
fn read_css_string(s: &str, quote: char) -> Option<(String, usize)> {
    let mut out = String::new();
    let mut chars = s.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        match c {
            c if c == quote => return Some((out, i + 1)),
            '\\' => {
                let (_, next) = chars.next()?;
                if next.is_ascii_hexdigit() {
                    let mut hex = String::from(next);
                    while hex.len() < 6 {
                        match chars.peek() {
                            Some((_, h)) if h.is_ascii_hexdigit() => {
                                hex.push(*h);
                                chars.next();
                            }
                            _ => break,
                        }
                    }
                    if let Some((_, ' ')) = chars.peek() {
                        chars.next();
                    }
                    out.push(
                        u32::from_str_radix(&hex, 16)
                            .ok()
                            .and_then(char::from_u32)
                            .unwrap_or('\u{FFFD}'),
                    );
                } else if next != '\n' {
                    out.push(next);
                }
            }
            c => out.push(c),
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Scanning CSS while respecting comments, strings and nesting

struct Scanner<'a> {
    src: &'a str,
    pos: usize,
}

impl<'a> Scanner<'a> {
    fn new(src: &'a str) -> Self {
        Scanner { src, pos: 0 }
    }

    fn seek(&mut self, pos: usize) {
        self.pos = pos;
    }

    fn rest_from(&self, at: usize) -> &'a str {
        &self.src[at..]
    }

    /// Index after a comment or string starting at `i`, if one does.
    fn skip_opaque(&self, i: usize) -> Option<usize> {
        let bytes = self.src.as_bytes();
        match bytes[i] {
            b'/' if bytes.get(i + 1) == Some(&b'*') => Some(
                self.src[i + 2..]
                    .find("*/")
                    .map_or(self.src.len(), |e| i + 2 + e + 2),
            ),
            q @ (b'"' | b'\'') => {
                let mut j = i + 1;
                while j < bytes.len() {
                    match bytes[j] {
                        b'\\' => j += 2,
                        b if b == q || b == b'\n' => return Some(j + 1),
                        _ => j += 1,
                    }
                }
                Some(bytes.len())
            }
            _ => None,
        }
    }

    /// Advances to the next `@` at brace depth zero and returns its index.
    fn next_top_level_at_rule(&mut self) -> Option<usize> {
        let bytes = self.src.as_bytes();
        let mut depth = 0usize;
        let mut i = self.pos;
        while i < bytes.len() {
            if let Some(next) = self.skip_opaque(i) {
                i = next;
                continue;
            }
            match bytes[i] {
                b'{' => depth += 1,
                b'}' => depth = depth.saturating_sub(1),
                b'@' if depth == 0 => {
                    self.pos = i + 1;
                    return Some(i);
                }
                _ => {}
            }
            i += 1;
        }
        self.pos = bytes.len();
        None
    }

    fn find_top_level_brace(&self, from: usize) -> Option<usize> {
        let bytes = self.src.as_bytes();
        let mut i = from;
        while i < bytes.len() {
            if let Some(next) = self.skip_opaque(i) {
                i = next;
                continue;
            }
            match bytes[i] {
                b'{' => return Some(i),
                b';' | b'}' => return None,
                _ => i += 1,
            }
        }
        None
    }

    fn find_matching_brace(&self, open: usize) -> Option<usize> {
        let bytes = self.src.as_bytes();
        let mut depth = 0usize;
        let mut i = open;
        while i < bytes.len() {
            if let Some(next) = self.skip_opaque(i) {
                i = next;
                continue;
            }
            match bytes[i] {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            }
            i += 1;
        }
        None
    }
}

// ---------------------------------------------------------------------------
// Matching

impl Matcher {
    /// Whether this matcher applies to `url`. `regexp` is evaluated with Rust's
    /// regex engine here, which differs from JavaScript's in corner cases; the
    /// extension's evaluation is the authoritative one.
    pub fn matches(&self, url: &str) -> bool {
        let url = url.split('#').next().unwrap_or(url);
        match self {
            Matcher::Url(u) => url == u.split('#').next().unwrap_or(u),
            Matcher::UrlPrefix(p) => url.starts_with(p.as_str()),
            Matcher::Domain(d) => host_of(url).is_some_and(|h| {
                let d = d.to_ascii_lowercase();
                h == d || h.ends_with(&format!(".{d}"))
            }),
            Matcher::Regexp(r) => {
                regex::Regex::new(&format!("^(?:{r})$")).is_ok_and(|re| re.is_match(url))
            }
        }
    }
}

fn host_of(url: &str) -> Option<String> {
    let after_scheme = url.split_once("://")?.1;
    let authority = after_scheme.split(['/', '?', '#']).next()?;
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = match host_port.strip_prefix('[') {
        Some(v6) => v6.split(']').next()?,
        None => host_port.split(':').next()?,
    };
    Some(host.to_ascii_lowercase())
}

impl Section {
    pub fn is_global(&self) -> bool {
        self.matchers.is_empty()
    }

    pub fn applies_to(&self, url: &str) -> bool {
        self.is_global() || self.matchers.iter().any(|m| m.matches(url))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXAMPLE: &str = r#"/* ==UserStyle==
@name           Example
@namespace      atelier
@version        1.0.0
@description    A test style
@preprocessor   default
@var color accent "Accent colour" #ff8800
@var range gap "Gap" [8, 0, 32, 1, "px"]
@var select density "Density" ["compact:Compact", "normal:Normal*", "roomy:Roomy"]
@var checkbox rounded "Rounded corners" 1
==/UserStyle== */

:root { color-scheme: dark; }

@-moz-document domain("example.com"), url-prefix("https://example.org/docs/") {
  body { background: var(--accent); }
  a[href*="}"] { color: red; } /* a brace in a string and } in a comment */
}

@-moz-document regexp("https://(www\\.)?example\\.net/.*") {
  @media (prefers-color-scheme: dark) { body { color: white; } }
}
"#;

    #[test]
    fn parses_metadata_and_vars() {
        let style = parse(EXAMPLE).unwrap();
        assert_eq!(style.meta.name.as_deref(), Some("Example"));
        assert_eq!(style.meta.preprocessor.as_deref(), Some("default"));
        let vars: Vec<_> = style
            .meta
            .vars
            .iter()
            .map(|v| (v.name.as_str(), v.default.as_str()))
            .collect();
        assert_eq!(
            vars,
            [
                ("accent", "#ff8800"),
                ("gap", "8px"),
                ("density", "normal"),
                ("rounded", "1")
            ]
        );
        assert_eq!(style.meta.vars[0].label, "Accent colour");
    }

    #[test]
    fn splits_sections() {
        let style = parse(EXAMPLE).unwrap();
        assert_eq!(style.sections.len(), 3);

        let global = &style.sections[0];
        assert!(global.is_global());
        assert_eq!(global.css, ":root { color-scheme: dark; }");

        assert_eq!(
            style.sections[1].matchers,
            [
                Matcher::Domain("example.com".into()),
                Matcher::UrlPrefix("https://example.org/docs/".into())
            ]
        );
        assert!(
            style.sections[1]
                .css
                .contains(r#"a[href*="}"] { color: red; }"#)
        );
        assert!(style.sections[1].css.ends_with("comment */"));

        // CSS string escapes are decoded: `\\.` in the source is `\.` in the regexp.
        assert_eq!(
            style.sections[2].matchers,
            [Matcher::Regexp(r"https://(www\.)?example\.net/.*".into())]
        );
        assert!(style.sections[2].css.starts_with("@media"));
    }

    #[test]
    fn no_global_section_when_only_metadata_and_comments() {
        let style = parse("/* ==UserStyle==\n@name x\n==/UserStyle== */\n/* hi */\n@-moz-document domain(a.com) { p {} }").unwrap();
        assert_eq!(style.sections.len(), 1);
        assert_eq!(
            style.sections[0].matchers,
            [Matcher::Domain("a.com".into())]
        );
    }

    #[test]
    fn unquoted_url_matcher() {
        let style = parse("@-moz-document url(https://a.com/x?y=1) { p {} }").unwrap();
        assert_eq!(
            style.sections[0].matchers,
            [Matcher::Url("https://a.com/x?y=1".into())]
        );
    }

    #[test]
    fn multiline_select() {
        let src = "/* ==UserStyle==\n@var select mode \"Mode\" {\n  \"Light\": \"l\",\n  \"Dark*\": \"d\"\n}\n==/UserStyle== */";
        let style = parse(src).unwrap();
        assert_eq!(style.meta.vars[0].default, "d");
    }

    #[test]
    fn rejects_other_preprocessors() {
        let err = parse("/* ==UserStyle==\n@preprocessor stylus\n==/UserStyle== */").unwrap_err();
        assert!(err.message.contains("stylus"));
    }

    #[test]
    fn reports_unclosed_blocks_with_line() {
        let err =
            parse("p {}\n\n@-moz-document domain(a.com) {\n  p { color: red; }\n").unwrap_err();
        assert_eq!(err.line, Some(3));
    }

    #[test]
    fn matching() {
        let d = Matcher::Domain("example.com".into());
        assert!(d.matches("https://example.com/"));
        assert!(d.matches("https://www.example.com:8443/a"));
        assert!(!d.matches("https://notexample.com/"));
        assert!(!d.matches("https://example.com.evil.org/"));

        let u = Matcher::Url("https://a.com/x".into());
        assert!(u.matches("https://a.com/x#frag"));
        assert!(!u.matches("https://a.com/x/y"));

        assert!(
            Matcher::UrlPrefix("https://a.com/docs/".into()).matches("https://a.com/docs/intro")
        );
        assert!(Matcher::Regexp(r"https://a\.com/\d+".into()).matches("https://a.com/42"));
        assert!(!Matcher::Regexp(r"https://a\.com/\d+".into()).matches("https://a.com/42/more"));
    }
}
