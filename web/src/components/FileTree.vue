<script setup lang="ts">
import { computed, ref, watch } from "vue";
const props = defineProps<{ files: { path: string }[]; selected: string }>();
const emit = defineEmits<{ select: [path: string] }>();
type Entry = { path: string; name: string; directory: boolean; depth: number };
const expanded = ref(new Set<string>());
const focused = ref("");
const tree = ref<HTMLElement>();
const entries = computed(() => {
  const nodes = new Map<string, Entry>();
  for (const file of props.files) {
    const parts = file.path.split("/");
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join("/");
      nodes.set(path, {
        path,
        name,
        directory: index < parts.length - 1,
        depth: index,
      });
    });
  }
  const result: Entry[] = [];
  function add(parent: string, depth: number) {
    const children = [...nodes.values()].filter(
      (item) =>
        item.depth === depth &&
        item.path.slice(0, item.path.lastIndexOf("/") + 1) === parent,
    );
    children.sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name),
    );
    for (const child of children) {
      result.push(child);
      if (child.directory && expanded.value.has(child.path))
        add(`${child.path}/`, depth + 1);
    }
  }
  add("", 0);
  return result;
});
watch(
  () => props.selected,
  (path) => {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++)
      expanded.value.add(parts.slice(0, i).join("/"));
    focused.value = path;
  },
  { immediate: true },
);
function activate(entry: Entry) {
  focused.value = entry.path;
  if (entry.directory) {
    if (expanded.value.has(entry.path)) expanded.value.delete(entry.path);
    else expanded.value.add(entry.path);
  } else emit("select", entry.path);
}
function focus(entry?: Entry) {
  if (!entry) return;
  focused.value = entry.path;
  const index = entries.value.findIndex((item) => item.path === entry.path);
  tree.value
    ?.querySelectorAll<HTMLElement>('[role="treeitem"]')
    [index]?.focus();
}
function keyboard(event: KeyboardEvent, entry: Entry) {
  const index = entries.value.findIndex((item) => item.path === entry.path);
  if (event.key === "ArrowDown") focus(entries.value[index + 1]);
  else if (event.key === "ArrowUp") focus(entries.value[index - 1]);
  else if (event.key === "Home") focus(entries.value[0]);
  else if (event.key === "End") focus(entries.value.at(-1));
  else if (event.key === "ArrowRight" && entry.directory) {
    if (expanded.value.has(entry.path)) focus(entries.value[index + 1]);
    else expanded.value.add(entry.path);
  } else if (event.key === "ArrowLeft") {
    if (entry.directory && expanded.value.has(entry.path))
      expanded.value.delete(entry.path);
    else
      focus(
        entries.value.find(
          (item) =>
            item.path === entry.path.slice(0, entry.path.lastIndexOf("/")),
        ),
      );
  } else return;
  event.preventDefault();
}
</script>

<template>
  <div ref="tree" role="tree" aria-label="Source files" class="file-tree">
    <button
      v-for="(entry, index) in entries"
      :key="entry.path"
      class="file"
      :class="{ selected: selected === entry.path, directory: entry.directory }"
      role="treeitem"
      :aria-level="entry.depth + 1"
      :aria-expanded="entry.directory ? expanded.has(entry.path) : undefined"
      :aria-selected="entry.directory ? undefined : selected === entry.path"
      :title="entry.path"
      :tabindex="focused === entry.path || (!focused && index === 0) ? 0 : -1"
      :style="{ paddingLeft: `${10 + entry.depth * 14}px` }"
      @click="activate(entry)"
      @keydown="keyboard($event, entry)"
    >
      <span class="file-symbol" aria-hidden="true">{{
        entry.directory
          ? expanded.has(entry.path)
            ? "⌄"
            : "›"
          : entry.name.endsWith(".js")
            ? "JS"
            : entry.name.endsWith(".py")
              ? "PY"
              : "·"
      }}</span>
      <span>{{ entry.name }}</span>
    </button>
  </div>
</template>
