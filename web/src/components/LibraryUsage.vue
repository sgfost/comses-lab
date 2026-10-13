<script setup lang="ts">
import { ref, onUnmounted } from "vue";
import type { Project, ProjectLibraries, LibraryDependency } from "../../../shared/contracts";
import { api } from "../api";
const props = defineProps<{ project: Project; signedIn: boolean }>();
const emit = defineEmits<{ "sign-in": [action: () => void] }>();
const dialog = ref<HTMLDialogElement>();
const mode = ref<'add' | 'examples'>('add');
const projects = ref<Project[]>([]);
const selected = ref('');
const loading = ref(false);
const error = ref('');
let request: AbortController | undefined;
function uses(libraries: LibraryDependency[]): boolean {
  return libraries.some(pin => pin.projectId === props.project.id || uses(pin.children));
}
async function open(value: 'add' | 'examples') {
  if (value === 'add' && !props.signedIn) { emit('sign-in', () => { void open('add'); }); return; }
  request?.abort(); const current = new AbortController(); request = current;
  mode.value = value; projects.value = []; selected.value = ''; error.value = ''; loading.value = true;
  dialog.value?.showModal();
  try {
    const catalog = (await api<{ projects: Project[] }>('/projects', { signal: current.signal })).projects;
    if (value === 'add') projects.value = catalog.filter(item => item.kind === 'model' && ['write', 'admin'].includes(item.permission) && (props.project.visibility === 'public' || item.visibility === 'private'));
    else {
      // Inspect accessible models only; nested dependencies count as examples too.
      const models = catalog.filter(item => item.kind === 'model');
      for (let offset = 0; offset < models.length; offset += 4) {
        if (current.signal.aborted) return;
        const matches = await Promise.all(models.slice(offset, offset + 4).map(async model => {
          try {
            const dependencies = await api<ProjectLibraries>(`/projects/${model.id}/libraries`, { signal: current.signal });
            return uses(dependencies.libraries) ? model : null;
          } catch {
            if (!current.signal.aborted) error.value = 'Some artifacts could not be checked.';
            return null;
          }
        }));
        if (!current.signal.aborted) projects.value.push(...matches.filter((model): model is Project => model !== null));
      }
    }
  } catch (cause) { if (!current.signal.aborted) error.value = (cause as Error).message; }
  finally { if (request === current) loading.value = false; }
}
function close() { request?.abort(); dialog.value?.close(); }
onUnmounted(() => request?.abort());
</script>
<template>
  <div class="library-use-actions">
    <button class="quiet" @click="open('examples')">Examples</button>
    <button class="launch-button" @click="open('add')">Add to artifact</button>
    <dialog ref="dialog" class="login-dialog library-dialog" @cancel="request?.abort()">
      <button class="close" aria-label="Close" @click="close">×</button>
      <h2>{{ mode === 'add' ? 'Add to artifact' : 'Artifacts using this library' }}</h2>
      <p>{{ project.title }}</p>
      <p v-if="loading" role="status">Loading…</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <template v-if="mode === 'add'">
        <label v-if="projects.length">Artifact<select aria-label="Artifact" v-model="selected"><option value="" disabled>Select artifact</option><option v-for="item in projects" :key="item.id" :value="item.id">{{ item.title }}</option></select></label>
        <p v-else-if="!loading && !error">No compatible artifacts you can edit. Sign in, create an artifact or fork one first.</p>
        <a v-if="selected" class="launch-button" :href="`#/project/${selected}?edit=1&library=${project.id}`" @click="close">Continue</a>
      </template>
      <template v-else>
        <a v-for="item in projects" :key="item.id" class="library-example" :href="`#/project/${item.id}`" @click="close"><strong>{{ item.title }} ↗</strong><span>{{ item.description }}</span></a>
        <p v-if="!loading && !error && !projects.length">No accessible artifacts use this library yet.</p>
      </template>
    </dialog>
  </div>
</template>
