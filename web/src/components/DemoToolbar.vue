<script setup lang="ts">
import { ref } from 'vue';
import { exportWorkspace, importWorkspace, resetWorkspace } from '../demo/storage';
const props = defineProps<{ prepare: () => Promise<boolean> }>();
const fileInput = ref<HTMLInputElement>();
const busy = ref(false);
const error = ref('');
async function perform(run: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try { if (await props.prepare()) await run(); } catch (cause) { error.value = (cause as Error).message; }
  finally { busy.value = false; }
}
function download() {
  return perform(async () => {
    const url = URL.createObjectURL(new Blob([await exportWorkspace()], { type:'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'comses-lab-workspace.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
async function upload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  await perform(async () => { await importWorkspace(await file.text()); location.reload(); });
  if (fileInput.value) fileInput.value.value = '';
}
function reset() {
  return perform(async () => {
    if (!confirm('Delete this browser’s demo projects, drafts, and saved versions? Bundled examples will remain. Export your workspace first if you want to keep it.')) return;
    await resetWorkspace(); location.hash = '/explore/artifacts'; location.reload();
  });
}
</script>
<template>
  <aside class="demo-banner" aria-label="Demo workspace">
    <div><strong>Interactive demo</strong><span>Changes stay in this browser. Nothing is published.</span></div>
    <div class="demo-actions">
      <button class="quiet" :disabled="busy" @click="download">Export workspace</button>
      <button class="quiet" :disabled="busy" @click="fileInput?.click()">Import workspace</button>
      <button class="quiet" :disabled="busy" @click="reset">Reset demo</button>
      <input ref="fileInput" type="file" accept="application/json,.json" aria-label="Import demo workspace" hidden @change="upload" />
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
  </aside>
</template>
