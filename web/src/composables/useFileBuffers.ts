import { computed, reactive } from "vue";

export interface FileBuffer {
  original: string | null | undefined;
  content: string | null;
}

export function useFileBuffers() {
  // Null means absent. Undefined original means an existing file not loaded as text.
  const files = reactive(new Map<string, FileBuffer>());
  const changed = computed(() =>
    [...files].filter(([, file]) => file.original !== file.content),
  );
  const dirty = computed(() => changed.value.length > 0);
  function load(path: string, content: string) {
    if (!files.has(path)) files.set(path, { original: content, content });
    return files.get(path)!;
  }
  function create(path: string) {
    const file = files.get(path);
    if (file) file.content = "";
    else files.set(path, { original: null, content: "" });
  }
  function remove(path: string) {
    const file = files.get(path);
    if (!file) files.set(path, { original: undefined, content: null });
    else if (file.original === null) files.delete(path);
    else file.content = null;
  }
  function discard(path: string) {
    const file = files.get(path);
    if (!file) return;
    if (file.original === null || file.original === undefined)
      files.delete(path);
    else file.content = file.original;
  }
  function snapshot() {
    return changed.value.map(([path, file]) => ({ path, ...file }));
  }
  function applied(submitted: ReturnType<typeof snapshot>) {
    for (const saved of submitted) {
      const current = files.get(saved.path);
      if (!current) continue;
      // Only the submitted content became committed. Later typing stays dirty.
      current.original = saved.content;
      if (current.original === null && current.content === null)
        files.delete(saved.path);
    }
  }
  return {
    files,
    changed,
    dirty,
    load,
    create,
    remove,
    discard,
    snapshot,
    applied,
  };
}
