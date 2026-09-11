// Syntax highlighting inside fenced code blocks, for the ~14 languages people
// actually paste into notes.
//
// Curated on purpose, NOT `@codemirror/language-data`: that package is a table
// of ~130 languages and pulls in around forty packages, for a note app where a
// fence is usually a shell command or a JSON blob. The cost of each entry here
// is a `LanguageDescription` — a name, some aliases, and a `load()` — and the
// grammar itself is a DYNAMIC import. Nothing below is in the startup bundle;
// the parser for a language is fetched the first time a fence claims it, and
// never at all in a vault with no code in it.
//
// `@codemirror/lang-markdown` resolves a fence's info string against this list
// itself (see `codeLanguages` in editor/index.ts) and re-parses that region with
// the nested grammar; the resulting tokens land on the code-token entries in
// `markdownHighlightSpec` (theme.ts), which map onto our own palette rather than
// CodeMirror's hardcoded `defaultHighlightStyle`.

import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";

export const codeLanguages: LanguageDescription[] = [
  LanguageDescription.of({
    name: "javascript",
    alias: ["js", "mjs", "cjs", "node", "jsx"],
    load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  }),
  LanguageDescription.of({
    name: "typescript",
    alias: ["ts", "tsx"],
    load: () =>
      import("@codemirror/lang-javascript").then((m) =>
        m.javascript({ jsx: true, typescript: true }),
      ),
  }),
  LanguageDescription.of({
    name: "python",
    alias: ["py"],
    load: () => import("@codemirror/lang-python").then((m) => m.python()),
  }),
  LanguageDescription.of({
    name: "rust",
    alias: ["rs"],
    load: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  }),
  LanguageDescription.of({
    name: "json",
    alias: ["jsonc"],
    load: () => import("@codemirror/lang-json").then((m) => m.json()),
  }),
  LanguageDescription.of({
    name: "yaml",
    alias: ["yml"],
    load: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  }),
  LanguageDescription.of({
    name: "sql",
    alias: ["postgres", "postgresql", "mysql", "sqlite"],
    load: () => import("@codemirror/lang-sql").then((m) => m.sql()),
  }),
  LanguageDescription.of({
    name: "css",
    load: () => import("@codemirror/lang-css").then((m) => m.css()),
  }),
  LanguageDescription.of({
    // Live preview RENDERS an html fence rather than showing it (livePreview.ts),
    // so this only ever applies while the caret is inside one — which is exactly
    // when you want it highlighted.
    name: "html",
    alias: ["htm"],
    load: () => import("@codemirror/lang-html").then((m) => m.html()),
  }),
  LanguageDescription.of({
    name: "markdown",
    alias: ["md"],
    load: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  }),
  LanguageDescription.of({
    name: "go",
    alias: ["golang"],
    load: () => import("@codemirror/lang-go").then((m) => m.go()),
  }),
  LanguageDescription.of({
    name: "java",
    load: () => import("@codemirror/lang-java").then((m) => m.java()),
  }),
  LanguageDescription.of({
    name: "cpp",
    alias: ["c", "c++", "h", "hpp"],
    load: () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  }),
  LanguageDescription.of({
    // The one stream grammar: shell has no Lezer parser, and a note app without
    // a highlighted `bash` fence is missing the commonest fence there is.
    name: "shell",
    alias: ["bash", "sh", "zsh", "console", "shellsession"],
    load: () =>
      import("@codemirror/legacy-modes/mode/shell").then(
        (m) => new LanguageSupport(StreamLanguage.define(m.shell)),
      ),
  }),
];
