<script setup lang="ts">
import { ref, watch, computed, onUnmounted, nextTick } from "vue";
import type { Project, ProjectLibraries, SourceTree, CommitHistory, CommitResponse, RefList, Draft } from "../../../shared/contracts";
import { api } from "../api";
import LibraryChildren from "./LibraryChildren.vue";
const props = defineProps<{ project: Project; commit: string; branch: string; editable: boolean; dirty: boolean; draftVersion?: number; useDraft?: boolean; flushDraft?: () => Promise<boolean>; initialLibraryId?: string }>();
const emit = defineEmits<{ busy: [value: boolean]; committed: [result: CommitResponse]; drafted: [result: { draft: Draft }]; requested: [] }>();
const installed = ref<Record<string, { date: string; latest: string }>>({});
let initialOpened = false;
const updating = ref(false);
const dependencies = ref<ProjectLibraries | null>(null);
const loading = ref(false);
const error = ref("");
const dialog = ref<HTMLDialogElement>();
const mode = ref<"install" | "remove">("install");
const catalog = ref<Project[]>([]);
const libraryId = ref("");
const revision = ref("");
const revisions = ref<CommitHistory | null>(null);
const sourceTree = ref<SourceTree | null>(null);
const paths = ref<string[]>([]);
const directory = ref("");
const message = ref("");
const formError = ref("");
const busy = ref(false);
const sourceLoading = ref(false);
const formOpen = ref(false);
const formCommit = ref("");
const formBranch = ref("");
let read: AbortController | undefined;
let sourceRead: AbortController | undefined;
let catalogRead: AbortController | undefined;
let formGeneration = 0;
let sourceGeneration = 0;
const canEdit = computed(() => props.editable && !props.dirty && !busy.value);
const formCurrent = computed(() => formCommit.value === props.commit && formBranch.value === props.branch);
async function load() {
  read?.abort(); const request = new AbortController(); read = request;
  dependencies.value = null; installed.value = {}; error.value = "";
  if (!props.commit) return;
  loading.value = true;
  try { const result = await api<ProjectLibraries>(`/projects/${props.project.id}/libraries?${props.useDraft ? "draft=1" : `commit=${props.commit}`}`, { signal: request.signal }); if (read === request && !request.signal.aborted) { dependencies.value = result;
      for (const pin of result.libraries) {
        if (!pin.project) continue;
        void (async () => {
          try {
            const history = await api<CommitHistory>(`/projects/${pin.projectId}/history?commit=${pin.commit}&limit=1`, { signal: request.signal });
            const refs = await api<RefList>(`/projects/${pin.projectId}/refs?kind=branch&limit=1`, { signal: request.signal });
            const latest = await api<SourceTree>(`/projects/${pin.projectId}/tree?ref=${encodeURIComponent(`refs/heads/${refs.defaultBranch}`)}`, { signal: request.signal });
            if (read === request && !request.signal.aborted) installed.value[pin.directory] = { date: history.commits[0]?.author.date ?? "", latest: latest.commit };
          } catch { /* The retained library remains usable if its source is unavailable. */ }
        })();
      }
    } }
  catch (cause) { if (!request.signal.aborted) error.value = (cause as Error).message; }
  finally { if (read === request) loading.value = false; }
}
watch(() => [props.commit, props.draftVersion, props.useDraft], load, { immediate: true });
async function loadLibrary() {
  sourceRead?.abort(); const request = new AbortController(); sourceRead = request; const generation = ++sourceGeneration;
  sourceLoading.value = true; sourceTree.value = null; revisions.value = null; paths.value = []; formError.value = "";
  if (!libraryId.value) { sourceLoading.value = false; return; }
  try {
    let selectedRevision = revision.value;
    if (!selectedRevision) {
      const refs = await api<RefList>(`/projects/${libraryId.value}/refs?kind=branch&limit=25`, { signal: request.signal });
      if (generation !== sourceGeneration || request.signal.aborted) return;
      selectedRevision = `refs/heads/${refs.defaultBranch}`;
    }
    const tree = await api<SourceTree>(`/projects/${libraryId.value}/tree?ref=${encodeURIComponent(selectedRevision)}`, { signal: request.signal });
    if (generation !== sourceGeneration || request.signal.aborted) return;
    revision.value = tree.commit; sourceTree.value = tree; paths.value = tree.files.map(file => file.path).filter(path => path !== "lab.lock.json");
    const history = await api<CommitHistory>(`/projects/${libraryId.value}/history?commit=${tree.commit}&limit=50`, { signal: request.signal });
    if (generation === sourceGeneration && !request.signal.aborted) revisions.value = history;
  } catch (cause) { if (!request.signal.aborted && generation === sourceGeneration) formError.value = (cause as Error).message; }
  finally { if (generation === sourceGeneration) sourceLoading.value = false; }
}
function chooseLibrary() { revision.value = ""; directory.value = `vendor/${catalog.value.find(item => item.id === libraryId.value)?.forgejoRepo || libraryId.value || "library"}`; void loadLibrary(); }
async function open(pin?: ProjectLibraries["libraries"][number], remove = false) {
  if (!canEdit.value) return;
  const generation = ++formGeneration;
  sourceRead?.abort(); sourceGeneration++;
  catalogRead?.abort(); const request = new AbortController(); catalogRead = request;
  updating.value = !!pin;
  mode.value = remove ? "remove" : "install"; formError.value = "";
  libraryId.value = pin?.projectId ?? props.initialLibraryId ?? ""; revision.value = ""; directory.value = pin?.directory ?? "";
  message.value = remove ? `Remove library ${pin?.directory}` : pin ? `Update library ${pin.directory}` : "Install library";
  formCommit.value = props.commit; formBranch.value = props.branch;
  sourceTree.value = null; revisions.value = null; paths.value = [];
  formOpen.value = true; await nextTick(); dialog.value?.showModal();
  if (remove) return;
  try { catalog.value = (await api<{projects:Project[]}>("/projects", { signal: request.signal })).projects.filter(project => project.kind === "library"); }
  catch (cause) { if (!request.signal.aborted && generation === formGeneration) formError.value = (cause as Error).message; }
  if (!formOpen.value || generation !== formGeneration || request.signal.aborted) return;
  if (pin) { await loadLibrary(); if (generation === formGeneration && libraryId.value === pin.projectId && sourceTree.value) paths.value = pin.files.map(file => file.source).filter(path => sourceTree.value!.files.some(file => file.path === path)); }
  else if (libraryId.value) chooseLibrary();
}
function close() { if (busy.value) return; sourceRead?.abort(); catalogRead?.abort(); sourceGeneration++; formGeneration++; formOpen.value = false; dialog.value?.close(); }
async function submit() {
  if (!canEdit.value || !formCurrent.value) return;
  busy.value = true; emit("busy", true); formError.value = "";
  try {
    if (props.flushDraft && !(await props.flushDraft())) { formError.value = "Save the draft before changing libraries."; return; }
    const result = await api<CommitResponse & { draft: Draft }>(`/projects/${props.project.id}/${props.useDraft ? "draft/libraries" : "libraries"}`, { method: mode.value === "remove" ? "DELETE" : "POST", body: JSON.stringify({ ref: formBranch.value, expectedCommit: formCommit.value, expectedVersion: props.draftVersion ?? 0, directory: directory.value, message: message.value.trim() || (mode.value === "remove" ? `Remove ${directory.value}` : `Add or update ${directory.value}`), ...(mode.value === "install" ? {libraryId: libraryId.value, commit: sourceTree.value?.commit, paths: paths.value} : {}) }) });
    if (props.useDraft) emit("drafted", result); else emit("committed", result); formOpen.value = false; dialog.value?.close();
  } catch (cause) { formError.value = (cause as Error).message; }
  finally { busy.value = false; emit("busy", false); }
}
watch(() => props.editable, enabled => {
  if (enabled && props.initialLibraryId && !initialOpened) { initialOpened = true; void open(); emit("requested"); }
}, { immediate: true });
onUnmounted(() => { read?.abort(); sourceRead?.abort(); catalogRead?.abort(); });
</script>
<template>
  <section class="libraries-panel" aria-label="Project libraries">
    <div class="libraries-heading"><h2>Libraries <span v-if="dependencies">{{ dependencies.libraries.length }}</span></h2><button v-if="editable" class="quiet" :disabled="!canEdit" @click="open()">Add library</button></div>
    <p v-if="dirty" class="field-note">Save or discard edits before changing libraries.</p>
    <p v-if="loading" class="empty" role="status">Loading libraries…</p>
    <p v-if="error" class="pane-error" role="alert">{{ error }} <button @click="load">Retry</button></p>
    <p v-else-if="dependencies && !dependencies.libraries.length" class="library-empty">No dependencies.</p>
    <article v-for="pin in dependencies?.libraries" :key="pin.directory" class="library-entry">
      <a v-if="pin.project" class="dependency-link" :aria-label="pin.project.title" :href="`#/project/${pin.projectId}?ref=${pin.commit}`">
        <span class="dependency-title">{{ pin.project.title }} <span aria-hidden="true">↗</span></span>
        <span class="dependency-author">{{ pin.project.ownerName }}</span>
        <span v-if="pin.project.description" class="dependency-description">{{ pin.project.description }}</span>
      </a><strong v-else>Unavailable library</strong>
      <div class="dependency-revision">Installed version<span v-if="installed[pin.directory]?.date"> · {{ new Date(installed[pin.directory]!.date).toLocaleDateString() }}</span></div>
      <button v-if="editable && installed[pin.directory] && installed[pin.directory]!.latest !== pin.commit" class="library-update quiet" :disabled="!canEdit || pin.modified" @click="open(pin)">Update available</button>
      <span v-if="pin.modified" class="pane-error">Installed files modified</span>
      <span v-if="pin.children.length" class="dependency-uses">Uses</span>
      <LibraryChildren :libraries="pin.children" />
      <details class="dependency-details"><summary>Details</summary>
        <code>{{ pin.commit }}</code>
        <div class="dependency-location">{{ pin.directory }} · {{ pin.files.length }} files</div>
        <div v-for="file in pin.files" :key="file.path" class="dependency-file"><code>{{ file.path }}</code></div>
        <div v-if="editable" class="library-actions"><button class="quiet" :disabled="!canEdit || !pin.project || pin.modified" @click="open(pin)">Update</button><button class="quiet" :disabled="!canEdit || pin.modified" @click="open(pin, true)">Remove</button></div>
      </details>
    </article>
    <a href="#/explore/libraries" class="browse-libraries">Browse libraries <span aria-hidden="true">→</span></a>
    <dialog ref="dialog" class="login-dialog library-dialog" @cancel.prevent="close" @click="$event.target === dialog && close()">
      <form v-if="formOpen" @submit.prevent="submit">
        <button class="close" type="button" :disabled="busy" aria-label="Close library dialog" @click="close">×</button>
        <h2>{{ mode === 'remove' ? 'Remove library' : updating ? 'Update library' : 'Add library' }}</h2>

        <template v-if="mode === 'install'">
          <label>Library<select v-model="libraryId" required :disabled="busy" @change="chooseLibrary"><option value="" disabled>Select library</option><option v-for="item in catalog" :value="item.id" :key="item.id">{{ item.title }} · {{ item.ownerName }}</option></select></label>
          <p v-if="catalog.find(item => item.id === libraryId)?.description" class="field-note">{{ catalog.find(item => item.id === libraryId)?.description }}</p>
          <label>Version<select aria-label="Library version" v-model="revision" :disabled="busy || !revisions" @change="loadLibrary"><option v-for="item in revisions?.commits" :key="item.commit" :value="item.commit">{{ new Date(item.author.date).toLocaleString() }} · {{ item.message.split('\n')[0] }}</option></select></label>
          <button type="button" class="quiet" :disabled="busy || !libraryId" @click="revision = ''; loadLibrary()">Use latest version</button>
          <p v-if="sourceLoading" role="status">Loading source…</p>
        </template>
        <details class="library-options"><summary>Files and version details</summary>
          <template v-if="mode === 'install'">
            <label>Exact revision<input v-model="revision" :disabled="busy" aria-label="Library revision" /></label>
            <button type="button" class="quiet" :disabled="busy || !libraryId || !revision" @click="loadLibrary">Load revision</button>
            <fieldset v-if="sourceTree" class="file-selection"><legend>Files to copy</legend><label v-for="file in sourceTree.files.filter(file => file.path !== 'lab.lock.json')" :key="file.path"><input v-model="paths" type="checkbox" :value="file.path" :disabled="busy" />{{ file.path }}</label></fieldset>
          </template>
        <label>Destination directory<input v-model="directory" required :disabled="busy || mode === 'remove'" placeholder="vendor/library" /></label>
        <label>What changed? (optional)<input v-model="message" :disabled="busy" /></label>
        </details>
        <p v-if="directory" class="field-note">{{ mode === 'remove' ? 'Remove from' : 'Files in' }} <code>{{ directory }}</code></p>
        <p v-if="!formCurrent" class="pane-error" role="alert">Destination revision changed. Close and reopen this form.</p>
        <p v-if="formError" class="pane-error" role="alert">{{ formError }}</p>
        <button class="launch-button" :disabled="!canEdit || !formCurrent || sourceLoading || !directory || (mode === 'install' && (!sourceTree || sourceTree.commit !== revision || !paths.length))">{{ busy ? 'Saving…' : mode === 'remove' ? 'Remove library' : updating ? 'Update library' : 'Add to artifact' }}</button>
      </form>
    </dialog>
  </section>
</template>
