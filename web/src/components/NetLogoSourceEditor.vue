<script setup lang="ts">
import { computed, ref, watch } from "vue";
import SourceEditor from "./SourceEditor.vue";
import { netLogoCodeSection } from "../netlogo-source";
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
const editor = ref<InstanceType<typeof SourceEditor>>();
const fullSource = ref(false);
watch(() => props.path, () => { fullSource.value = false; });
const section = computed(() => {
  try { return { value: netLogoCodeSection(props.content, props.path), error: "" }; }
  catch (cause) { return { value: undefined, error: (cause as Error).message }; }
});
const showFull = computed(() => fullSource.value || !section.value.value);
function update(content: string) {
  emit("update:content", showFull.value ? content : section.value.value!.replace(content));
}
defineExpose({ focus: () => editor.value?.focus(), find: () => editor.value?.find() });
</script>
<template>
  <div class="netlogo-source-editor">
    <div class="netlogo-source-toolbar" aria-label="NetLogo source view">
      <button type="button" :aria-pressed="!showFull" :disabled="!section.value" @click="fullSource = false">Code</button>
      <button type="button" :aria-pressed="showFull" @click="fullSource = true">Full model</button>
      <span v-if="!showFull">Interface and shapes are preserved.</span>
    </div>
    <p v-if="section.error" class="netlogo-source-error" role="status">{{ section.error }}</p>
    <SourceEditor
      :key="`${path}:${showFull}`"
      ref="editor"
      :content="showFull ? content : section.value!.code"
      :path="showFull ? path : 'model.netlogo'"
      :label="label ?? (showFull ? 'Full NetLogo model' : 'NetLogo code')"
      :editable="editable"
      @update:content="update"
      @cursor="(line, column) => emit('cursor', line, column)"
    />
  </div>
</template>
<style scoped>
.netlogo-source-editor { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.netlogo-source-editor :deep(.source-editor) { flex: 1; min-height: 0; }
.netlogo-source-toolbar { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-bottom: 1px solid var(--border); font-size: 11px; }
.netlogo-source-toolbar button { padding: 5px 8px; flex-shrink: 0; white-space: nowrap; border: 0; border-radius: 8px; background: var(--panel); color: var(--muted); cursor: pointer; font: inherit; }
.netlogo-source-toolbar button[aria-pressed="true"] { color: var(--accent); background: var(--accent-wash); }
.netlogo-source-toolbar button:disabled { opacity: .5; cursor: default; }
.netlogo-source-toolbar span { color: var(--muted); margin-left: auto; }
.netlogo-source-error { margin: 0; padding: 8px 12px; color: var(--muted); font-size: 12px; }
</style>
