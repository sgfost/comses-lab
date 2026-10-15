<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { FileTree } from "@pierre/trees";

const props = defineProps<{ files: { path: string }[]; selected: string }>();
const emit = defineEmits<{ select: [path: string] }>();
const host = ref<HTMLElement>();
let tree: FileTree | undefined;
let unsubscribe: (() => void) | undefined;
const treeHeight = ref(32);

function syncSelection() {
  if (!tree) return;
  for (const path of tree.getSelectedPaths()) {
    if (path !== props.selected) tree.getItem(path)?.deselect();
  }
  const item = tree.getItem(props.selected);
  if (!item || item.isDirectory()) return;
  const parts = props.selected.split("/");
  for (let i = 1; i < parts.length; i++) {
    const parent = tree.getItem(parts.slice(0, i).join("/"));
    if (parent && "expand" in parent) parent.expand();
  }
  item.select();
  tree.scrollToPath(props.selected, { offset: "nearest", focus: false });
}

function activate(event: MouseEvent | KeyboardEvent) {
  if (!event.composedPath().some(target => target instanceof HTMLElement && target.getAttribute("role") === "treeitem")) return;
  if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
  const item = tree?.getFocusedItem();
  if (!item || item.isDirectory()) return;
  if (event instanceof KeyboardEvent) event.preventDefault();
  for (const path of tree!.getSelectedPaths()) {
    if (path !== item.getPath()) tree!.getItem(path)?.deselect();
  }
  item.select();
  emit("select", item.getPath());
}

onMounted(() => {
  tree = new FileTree({
    paths: props.files.map(file => file.path),
    initialExpansion: "closed",
    flattenEmptyDirectories: false,
    icons: "standard",
    itemHeight: 32,
  });
  const updateHeight = () => { treeHeight.value = Math.max(32, tree!.getVisibleCount() * 32); };
  unsubscribe = tree.subscribe(updateHeight);
  updateHeight();
  tree.render({ containerWrapper: host.value! });
  // Trees owns the shadow DOM; label its tree landmark for assistive technology.
  tree.getFileTreeContainer()?.shadowRoot?.querySelector('[role="tree"]')?.setAttribute("aria-label", "Source files");
  syncSelection();
});

watch(() => props.selected, syncSelection);
watch(() => props.files.map(file => file.path), (paths, previous) => {
  if (!tree || paths.length === previous.length && paths.every((path, i) => path === previous[i])) return;
  const expanded = tree.getVisibleRows(0, tree.getVisibleCount() - 1)
    .filter(row => row.kind === "directory" && row.isExpanded).map(row => row.path);
  tree.resetPaths(paths, { initialExpandedPaths: expanded });
  syncSelection();
});
onBeforeUnmount(() => { unsubscribe?.(); tree?.cleanUp(); });
</script>

<template>
  <div ref="host" class="file-tree" :style="{ '--file-tree-height': `${treeHeight}px` }" @click="activate" @keydown.capture="activate" />
</template>
