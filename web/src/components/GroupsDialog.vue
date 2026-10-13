<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted, useId } from "vue";
import type { Group, GroupMember, GroupResponse, User, UpdateGroupMembersRequest } from "../../../shared/contracts";
import { api } from "../api";
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const titleId = useId();
const dialog = ref<HTMLDialogElement>();
const groups = ref<Group[]>([]);
const selected = ref("");
const detail = ref<GroupResponse | null>(null);
const candidates = ref<User[]>([]);
const draft = ref<GroupMember[]>([]);
const candidate = ref("");
const busy = ref(false);
const error = ref("");
let version = 0;
let generation = 0;
let intent: UpdateGroupMembersRequest | undefined;
const available = computed(() => candidates.value.filter(user => !draft.value.some(member => member.userId === user.id)));
function reset() {
  if (!detail.value) return;
  draft.value = detail.value.members.map(member => ({ ...member }));
  version = detail.value.group.version;
  candidate.value = "";
  intent = undefined;
  error.value = "";
}
async function load(id: string, replace = true) {
  if (busy.value) return;
  const request = ++generation;
  selected.value = id;
  if (replace) { detail.value = null; draft.value = []; candidates.value = []; intent = undefined; version = 0; }
  busy.value = true;
  error.value = "";
  try {
    const result = await api<GroupResponse>(`/groups/${id}`);
    const users = result.group.permission === "admin" ? (await api<{ users: User[] }>(`/groups/${id}/candidates`)).users : [];
    if (request !== generation || !props.open) return;
    detail.value = result;
    candidates.value = users;
    if (replace) reset();
  } catch (cause) { if (request === generation) error.value = (cause as Error).message; }
  finally { if (request === generation) busy.value = false; }
}
function add() {
  const user = available.value.find(user => user.id === candidate.value);
  if (user) draft.value.push({ userId: user.id, username: user.username, displayName: user.displayName, permission: "read" });
  candidate.value = "";
}
async function save(retry = false) {
  if (busy.value || !detail.value) return;
  if (!retry) {
    const body = { expectedVersion: version, members: draft.value.map(({ userId, permission }) => ({ userId, permission })).sort((a, b) => a.userId.localeCompare(b.userId)) };
    if (!intent || JSON.stringify({ ...intent, requestId: undefined }) !== JSON.stringify(body)) intent = { requestId: crypto.randomUUID(), ...body };
  }
  if (!intent && !retry) return;
  const request = ++generation;
  busy.value = true;
  error.value = "";
  try {
    const result = await api<GroupResponse>(`/groups/${selected.value}/${retry ? "retry" : "members"}`, { method: retry ? "POST" : "PUT", body: JSON.stringify(retry && detail.value.sync.state === "pending" ? { operationId: detail.value.sync.operationId } : intent) });
    if (request !== generation || !props.open) return;
    detail.value = result;
    if (result.sync.state === "ready") reset();
    emit("changed");
  } catch (cause) { if (request === generation) error.value = (cause as Error).message; }
  finally { if (request === generation) busy.value = false; }
}
watch(() => props.open, async open => {
  const request = ++generation;
  if (!open) { dialog.value?.close(); detail.value = null; draft.value = []; candidates.value = []; intent = undefined; busy.value = false; return; }
  await nextTick();
  if (request !== generation || !props.open) return;
  dialog.value?.showModal();
  busy.value = true;
  error.value = "";
  try {
    const result = await api<{ groups: Group[] }>("/groups");
    if (request !== generation || !props.open) return;
    groups.value = result.groups;
    busy.value = false;
    if (groups.value[0]) await load(groups.value[0].id);
  } catch (cause) { if (request === generation) error.value = (cause as Error).message; }
  finally { if (request === generation) busy.value = false; }
});
onUnmounted(() => { generation++; });
</script>
<template>
  <dialog ref="dialog" class="login-dialog groups-dialog" :aria-labelledby="titleId" @cancel.prevent="!busy && emit('close')">
    <button class="close" aria-label="Close groups" :disabled="busy" @click="emit('close')">×</button>
    <h2 :id="titleId">Groups</h2>
    <select :value="selected" aria-label="Research group" :disabled="busy" @change="load(($event.target as HTMLSelectElement).value)"><option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option></select>
    <p v-if="!busy && !groups.length && !error">No groups.</p>
    <template v-if="detail">
      <p class="access-status">{{ detail.group.permission === 'admin' ? 'Owner' : detail.group.permission }} · v{{ detail.group.version }}</p>
      <div v-if="detail.sync.state === 'pending'" role="status" class="pending-access"><p>Membership change pending. Confirmed members below are historical.</p><p>{{ detail.sync.message }}</p><p>{{ detail.sync.unconfirmedProjectIds.length }} projects unconfirmed.</p><p>Desired: {{ detail.sync.desiredMembers.map(member => `${member.displayName} (${member.permission})`).join(', ') || 'No members' }}</p><button v-if="detail.group.permission === 'admin'" class="quiet" :disabled="busy" @click="save(true)">Retry membership change</button></div>
      <form v-if="detail.group.permission === 'admin'" @submit.prevent="save()">
        <div v-for="member in draft" :key="member.userId" class="member-row"><span>{{ member.displayName }} <small>{{ member.username }}</small></span><select v-model="member.permission" :aria-label="`Permission for ${member.username}`" :disabled="busy || detail.sync.state === 'pending'"><option value="read">Read</option><option value="write">Write</option></select><button type="button" class="quiet" :aria-label="`Remove ${member.username}`" :disabled="busy || detail.sync.state === 'pending'" @click="draft = draft.filter(item => item.userId !== member.userId)">Remove</button></div>
        <div class="member-row"><select v-model="candidate" aria-label="Add group member" :disabled="busy || detail.sync.state === 'pending'"><option value="">Choose member</option><option v-for="user in available" :key="user.id" :value="user.id">{{ user.displayName }} ({{ user.username }})</option></select><button type="button" class="quiet" :disabled="busy || !candidate || detail.sync.state === 'pending'" @click="add">Add member</button></div>
        <div class="dialog-actions"><button class="quiet" :disabled="busy || detail.sync.state === 'pending'">Save members</button><button type="button" class="quiet" :disabled="busy || detail.sync.state === 'pending'" @click="reset">Reload member form</button></div>
      </form>
      <div v-else><p v-for="member in detail.members" :key="member.userId" class="member-row">{{ member.displayName }} · {{ member.permission }}</p></div>
      <button class="quiet" :disabled="busy" @click="load(selected, false)">Refresh group status</button>
    </template>
    <p v-if="busy" role="status">Loading…</p><p v-if="error" class="pane-error" role="alert">{{ error }}</p>
  </dialog>
</template>
