# docs.python.org

## How the site works

- Sphinx, with python-docs-theme: classic.css, then pydoctheme.css (light),
  then pydoctheme_dark.css and pygments_dark.css. The Theme select in the
  header (Auto/Light/Dark, saved as localStorage `currentTheme`) works by
  setting those two links' `media` to "(prefers-color-scheme: dark)", "all"
  or "not all". Dispatching a change event on the select from eval didn't
  switch it; setting localStorage and reloading does (in a throwaway tab).
- Few tokens: only admonitions (--*-background/--*-border), version notes
  (--versionadded etc.), and --good/--middle/--bad colours. Everything else
  is hard-coded, so the styles set colours explicitly, prefixed `html body`
  to outrank the site whatever the order. That also makes them independent
  of the site's mode, so there's no prerequisite.
- classic.css gives headings their own font stack as `div.body h1` etc.
  (0,1,2); the font rule carries `:not(.atelier-none)` to beat it.
- Layout: body > div.mobile-nav (fixed top bar, below 1024px), div.related
  (header nav), div.document (sticky div.sphinxsidebar with #sidebarbutton,
  the collapse handle; div.documentwrapper > div.bodywrapper > div.body),
  div.related again (bottom nav), div.footer. Below 1024px the sidebar and
  most of the header go, replaced by the top bar and .menu-wrapper.
- div.related is width: 100% (content-box); padding needs box-sizing.
- Diagrams marked img.invert-in-dark-mode are inverted by the site itself
  in its dark mode (black boxes); left as the site draws them.

## tiled

- Header (top div.related), sidebar and footer (bottom div.related +
  div.footer) are mantle panes meeting the column at muted rules; the
  page's 1em inset is removed. `html` is mantle so a short page's footer
  pane reaches the window's bottom without changing layout.
- Admonitions: 2px left edge, no box. Lavender for note, see also, tip,
  hint, attention and plain ones; yellow for warning/caution; red for
  danger/error. Version notes keep green/yellow/red edges at 2px; soft
  deprecation is mauve.
- Visited mauve only on links leaving the page: same-page anchors and
  identifier cross-references (a.reference.internal wrapping code.xref)
  stay lavender.
- Home page section titles (a.biglink) are text colour, not dimmed when
  visited (they're the docs' own sections). Search result titles are text
  colour, dimmed when visited. The module index stays lavender: it's a
  list of identifiers.
- Doctest output (.go) is text colour, the >>> prompt dim.
- Tables keep their cell rules, muted and square; header cells mantle.
