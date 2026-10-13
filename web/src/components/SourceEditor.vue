<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue";
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  drawSelection,
  Decoration,
  ViewPlugin,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  foldGutter,
  foldKeymap,
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  StreamLanguage,
} from "@codemirror/language";
import {
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel,
} from "@codemirror/search";
import { tags } from "@lezer/highlight";
const props = defineProps<{
  content: string;
  path: string;
  label?: string;
  editable?: boolean;
}>();
const emit = defineEmits<{
  cursor: [line: number, column: number];
  "update:content": [content: string];
}>();
const host = ref<HTMLElement>();
const language = new Compartment();
const editing = new Compartment();
let view: EditorView | undefined;
async function languageFor(path: string) {
  if (/\.[cm]?[jt]sx?$/.test(path))
    return (await import("@codemirror/lang-javascript")).javascript({
      typescript: /\.tsx?$/.test(path),
      jsx: /\.[jt]sx$/.test(path),
    });
  if (/\.(netlogo|nlogo)$/i.test(path)) return netlogoLanguage;
  if (/\.nlogox$/i.test(path)) return (await import("@codemirror/lang-html")).html();
  if (/\.html?$/.test(path))
    return (await import("@codemirror/lang-html")).html();
  if (/\.py$/.test(path))
    return (await import("@codemirror/lang-python")).python();
  if (/\.(md|markdown)$/.test(path))
    return (await import("@codemirror/lang-markdown")).markdown();
  return [];
}
const netlogoLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match(/;.*/)) return "comment";
    if (stream.match(/"(?:[^"\\]|\\.)*(?:"|$)/)) return "string";
    if (stream.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?=\s|[\[\]()]|$)/)) return "number";
    if (stream.match(/(?:true|false)\b/i)) return "bool";
    if (stream.match(/(?:to-report|to|end|globals|breed|directed-link-breed|undirected-link-breed|extensions|__includes|let|set|ifelse-value|ifelse|if|ask|report|stop|repeat|while|foreach|carefully|runresult|run)(?=\s|[\[\]()]|$)/i)) return "keyword";
    stream.match(/[^\s\[\]()";]+/) || stream.next();
    return null;
  },
  languageData: { commentTokens: { line: ";" }, closeBrackets: { brackets: ["(", "[", '\"'] } },
});
let languageGeneration = 0;
async function configureLanguage(path: string) {
  const generation = ++languageGeneration;
  try {
    const extension = await languageFor(path);
    if (view && generation === languageGeneration)
      view.dispatch({ effects: language.reconfigure(extension) });
  } catch {
    // Source remains readable if an optional language bundle cannot load.
  }
}
function diffDecorations(view: EditorView) {
  const lines = [];
  for (const range of view.visibleRanges) {
    for (let position = range.from; position <= range.to; ) {
      const line = view.state.doc.lineAt(position);
      const text = line.text;
      const kind = /^(diff --git |index |--- |\+\+\+ )/.test(text)
        ? "diff-header"
        : text.startsWith("@@")
          ? "diff-hunk"
          : text.startsWith("+")
            ? "diff-added"
            : text.startsWith("-")
              ? "diff-removed"
              : "";
      if (kind) lines.push(Decoration.line({ class: kind }).range(line.from));
      position = line.to + 1;
    }
  }
  return Decoration.set(lines, true);
}
const diffHighlighting = ViewPlugin.define(
  (view) => ({
    decorations: diffDecorations(view),
    update(update) {
      if (update.docChanged || update.viewportChanged)
        this.decorations = diffDecorations(update.view);
    },
  }),
  { decorations: (plugin) => plugin.decorations },
);
const highlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.keyword, color: "var(--syntax-keyword)" },
    {
      tag: [tags.string, tags.special(tags.string)],
      color: "var(--syntax-string)",
    },
    { tag: [tags.number, tags.bool, tags.null], color: "var(--syntax-number)" },
    { tag: tags.comment, color: "var(--syntax-comment)" },
    { tag: [tags.tagName, tags.typeName], color: "var(--syntax-keyword)" },
    {
      tag: [tags.attributeName, tags.propertyName],
      color: "var(--syntax-property)",
    },
    { tag: tags.heading, fontWeight: "700" },
    { tag: tags.link, textDecoration: "underline" },
  ]),
);
function editorTheme() {
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        color: "var(--text)",
        backgroundColor: "var(--background)",
        fontSize: "12px",
      },
      ".cm-scroller": {
        overflow: "auto",
        fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
        lineHeight: "1.65",
      },
      ".cm-content": { padding: "12px 0", caretColor: "var(--text)" },
      ".cm-line": { padding: "0 12px 0 7px" },
      ".cm-gutters": {
        backgroundColor: "var(--background)",
        color: "var(--muted)",
        border: "none",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        minWidth: "38px",
        paddingRight: "8px",
      },
      ".cm-activeLine, .cm-activeLineGutter": {
        backgroundColor: "var(--active-line)",
      },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection":
        { backgroundColor: "var(--editor-selection) !important" },
      ".cm-panels": {
        backgroundColor: "var(--panel)",
        color: "var(--text)",
        borderColor: "var(--border)",
      },
      ".cm-searchMatch": { backgroundColor: "var(--search-match)" },
      ".cm-searchMatch-selected": {
        backgroundColor: "var(--editor-selection)",
      },
      "&.cm-focused": { outline: "none" },
    },
    { dark: false },
  );
}
function editingMode() {
  return [
    EditorState.readOnly.of(!props.editable),
    EditorView.editable.of(!!props.editable),
    EditorView.contentAttributes.of({
      tabindex: "0",
      "aria-label": props.label ?? "Source code",
      "aria-readonly": String(!props.editable),
    }),
  ];
}
function separator(content: string) {
  // Keep CRLF files intact; mixed endings retain their literal CR characters.
  if (content.includes("\r\n") && !/(?<!\r)\n|\r(?!\n)/.test(content))
    return "\r\n";
  if (content.includes("\r") && !content.includes("\n")) return "\r";
  return "\n";
}
function editorState(content: string) {
  return EditorState.create({
    doc: content,
    extensions: [
      EditorState.lineSeparator.of(separator(content)),
      editing.of(editingMode()),
      history(),
      lineNumbers(),
      foldGutter(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      bracketMatching(),
      highlightSelectionMatches(),
      highlighting,
      ...(props.path === "commit.diff" ? [diffHighlighting] : []),
      keymap.of([
        ...searchKeymap,
        ...foldKeymap,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      language.of([]),
      editorTheme(),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) emit("update:content", update.state.sliceDoc());
        if (update.selectionSet || update.docChanged) {
          const position = update.state.selection.main.head;
          const line = update.state.doc.lineAt(position);
          emit("cursor", line.number, position - line.from + 1);
        }
      }),
    ],
  });
}
onMounted(() => {
  view = new EditorView({
    parent: host.value,
    state: editorState(props.content),
  });
  void configureLanguage(props.path);
});
watch(
  () => [props.content, props.path] as const,
  ([content, path], [, previousPath]) => {
    if (!view || (path === previousPath && content === view.state.sliceDoc()))
      return;
    view.setState(editorState(content));
    void configureLanguage(path);
    view.scrollDOM.scrollTop = 0;
    emit("cursor", 1, 1);
  },
);
watch(
  () => props.editable,
  () => view?.dispatch({ effects: editing.reconfigure(editingMode()) }),
);
onUnmounted(() => {
  languageGeneration++;
  view?.destroy();
  view = undefined;
});
defineExpose({
  focus: () => view?.focus(),
  find: () => {
    if (view) {
      openSearchPanel(view);
    }
  },
});
</script>

<template><div ref="host" class="source-editor"></div></template>
