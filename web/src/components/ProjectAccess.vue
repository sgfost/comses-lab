<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from "vue";
import type { Group, Project, ProjectAccessResponse, UpdateProjectAccessRequest } from "../../../shared/contracts";
import { api } from "../api";
const props = defineProps<{ project: Project; status: ProjectAccessResponse | null }>();
const emit = defineEmits<{ status: [value: ProjectAccessResponse]; updated: [value: Project] }>();
const groups = ref<Group[]>([]);
const visibility = ref<"public" | "private">("private");
const groupId = ref("");
const confirmPublic = ref(false);
const busy = ref(false);
const error = ref("");
const version = ref(0);
let intent: UpdateProjectAccessRequest | undefined;
let disposed = false;
const pending = computed(() => props.status?.sync.state === "pending");
function groupName(id: string | null) { return id ? groups.value.find(group => group.id === id)?.name ?? id : "None"; }
function reset() {
  if (!props.status) return;
  visibility.value = props.status.effective.visibility;
  groupId.value = props.status.effective.groupId ?? "";
  version.value = props.status.version;
  confirmPublic.value = false;
  intent = undefined;
  error.value = "";
}
watch(() => props.status, value => { if (value && !version.value) reset(); }, { immediate: true });
async function refresh() {
  busy.value = true;
  error.value = "";
  try {
    const result = await api<ProjectAccessResponse>(`/projects/${props.project.id}/access`);
    if (disposed) return;
    emit("status", result);
    if (result.sync.state === "ready") { const project = (await api<{ project: Project }>(`/projects/${props.project.id}`)).project; if (!disposed) emit("updated", project); }
  } catch (cause) { if (!disposed) error.value = (cause as Error).message; }
  finally { if (!disposed) busy.value = false; }
}
async function save(retry = false) {
  if (busy.value || !props.status) return;
  if (!retry) {
    const body = { expectedVersion: version.value, visibility: visibility.value, groupId: groupId.value || null, ...(confirmPublic.value ? { confirmPublic: true as const } : {}) };
    if (!intent || JSON.stringify({ ...intent, requestId: undefined }) !== JSON.stringify(body)) intent = { requestId: crypto.randomUUID(), ...body };
  }
  if (!intent && !retry) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await api<ProjectAccessResponse>(`/projects/${props.project.id}/access${retry ? "/retry" : ""}`, { method: retry ? "POST" : "PUT", body: JSON.stringify(retry && props.status.sync.state === "pending" ? { operationId: props.status.sync.operationId } : intent) });
    if (disposed) return;
    emit("status", result);
    if (result.sync.state === "ready") {
      version.value = result.version;
      visibility.value = result.effective.visibility;
      groupId.value = result.effective.groupId ?? "";
      confirmPublic.value = false;
      intent = undefined;
    }
    const project = (await api<{ project: Project }>(`/projects/${props.project.id}`)).project;
    if (!disposed) emit("updated", project);
  } catch (cause) { if (!disposed) error.value = (cause as Error).message; }
  finally { if (!disposed) busy.value = false; }
}
onMounted(async () => {
  try { const result = await api<{ groups: Group[] }>("/groups"); if (!disposed) groups.value = result.groups; }
  catch (cause) { if (!disposed) error.value = (cause as Error).message; }
});
onUnmounted(() => { disposed = true; });
</script>
<template>
  <section class="access-panel" aria-label="Artifact access">
    <div class="access-heading"><h3>Access</h3><button class="quiet" :disabled="busy" @click="refresh">Refresh status</button></div>
    <template v-if="status">
      <p class="access-status">Confirmed: {{ status.effective.visibility }} · Group: {{ groupName(status.effective.groupId) }} · v{{ status.version }}</p>
      <div v-if="status.sync.state === 'pending'" role="status" class="pending-access">
        <p>Pending: {{ status.sync.desired.visibility }} · Group: {{ groupName(status.sync.desired.groupId) }}</p>
        <p>Owner read-only. Direct Git access is unconfirmed.</p>
        <p>{{ status.sync.message }}</p>
        <button class="quiet" :disabled="busy" @click="save(true)">Retry access change</button>
      </div>
      <form class="access-form" @submit.prevent="save()">
        <label>Visibility<select v-model="visibility" aria-label="Artifact visibility" :disabled="busy || pending"><option value="private">Private</option><option value="public">Public</option></select></label>
        <label>Group<select v-model="groupId" aria-label="Artifact group" :disabled="busy || pending"><option value="">None</option><option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option></select></label>
        <label v-if="visibility === 'public' && status.effective.visibility === 'private'" class="public-confirmation"><input v-model="confirmPublic" type="checkbox" :disabled="busy || pending" />Make all Git history public</label>
        <div class="dialog-actions"><button class="quiet" :disabled="busy || pending || (visibility === 'public' && status.effective.visibility === 'private' && !confirmPublic)">Save access</button><button type="button" class="quiet" :disabled="busy || pending" @click="reset">Reload access form</button></div>
      </form>
    </template>
    <p v-if="error" class="pane-error" role="alert">{{ error }}</p>
  </section>
</template>
