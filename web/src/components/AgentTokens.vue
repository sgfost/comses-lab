<script setup lang="ts">
import { nextTick, onUnmounted, ref, useId, watch } from "vue";
import type { Project, Grant as AgentGrant } from "../../../shared/contracts";
import { api } from "../api";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const titleId = useId();
const dialog = ref<HTMLDialogElement>();
const grants = ref<AgentGrant[]>([]);
const projects = ref<Project[]>([]);
const permissions = ref<Record<string, "" | "read" | "write">>({});
const name = ref("");
const allowCreate = ref(false);
const token = ref("");
const busy = ref(false);
const error = ref("");
const copied = ref(false);
const baseUrl = `${location.origin}/api`;
const instructions = `Read ${baseUrl}/agent-guide and connect to CoMSES Lab using its browser approval flow. Request only the project access needed for our task, and show me the approval link and matching code. Keep credentials in local secure storage, outside chat and source files.`;
let generation = 0;

function clear() {
  token.value = "";
  name.value = "";
  allowCreate.value = false;
  permissions.value = {};
  copied.value = false;
}
watch(() => props.open, async open => {
  const request = ++generation;
  clear();
  error.value = "";
  if (!open) { dialog.value?.close(); busy.value = false; return; }
  await nextTick();
  if (request !== generation || !props.open) return;
  dialog.value?.showModal();
  busy.value = true;
  try {
    const [list, catalog] = await Promise.all([
      api<{ grants: AgentGrant[] }>("/agent-grants"),
      api<{ projects: Project[] }>("/projects"),
    ]);
    if (request !== generation || !props.open) return;
    grants.value = list.grants;
    projects.value = catalog.projects;
    permissions.value = Object.fromEntries(catalog.projects.map(project => [project.id, ""]));
  } catch (cause) { if (request === generation) error.value = (cause as Error).message; }
  finally { if (request === generation) busy.value = false; }
});
async function create() {
  if (busy.value || !name.value.trim()) return;
  const request = ++generation;
  busy.value = true;
  error.value = "";
  token.value = "";
  copied.value = false;
  try {
    const scopes = Object.entries(permissions.value).filter(([, permission]) => permission).map(([projectId, permission]) => ({ projectId, permission }));
    const result = await api<{ grant: AgentGrant; token: string }>("/agent-grants", {
      method: "POST", body: JSON.stringify({ name: name.value.trim(), allowCreate: allowCreate.value, projects: scopes }),
    });
    if (request !== generation || !props.open) return;
    grants.value.unshift(result.grant);
    token.value = result.token;
    name.value = "";
    allowCreate.value = false;
    permissions.value = Object.fromEntries(projects.value.map(project => [project.id, ""]));
  } catch (cause) { if (request === generation) error.value = (cause as Error).message; }
  finally { if (request === generation) busy.value = false; }
}
async function revoke(id: string) {
  if (busy.value) return;
  const request = ++generation;
  busy.value = true;
  error.value = "";
  try {
    const result = await api<{ grant: AgentGrant }>(`/agent-grants/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (request !== generation || !props.open) return;
    grants.value = grants.value.map(grant => grant.id === id ? result.grant : grant);
    token.value = "";
  } catch (cause) { if (request === generation) error.value = (cause as Error).message; }
  finally { if (request === generation) busy.value = false; }
}
async function copy(value: string, secret = false) {
  try { await navigator.clipboard.writeText(value); if (secret) copied.value = true; }
  catch { error.value = "Copy failed. Select and copy the text manually."; }
}
onUnmounted(() => { generation++; clear(); });
</script>

<template>
  <dialog ref="dialog" class="login-dialog agents-dialog" :aria-labelledby="titleId" @cancel.prevent="emit('close')">
    <button class="close" aria-label="Close agents" @click="emit('close')">×</button>
    <h2 :id="titleId">Agents</h2>
    <section class="instructions" aria-label="Agent instructions">
      <p>Give your agent this guide. It will send you here to approve access.</p>
      <a :href="`${baseUrl}/agent-guide`" target="_blank" rel="noopener">Agent guide ↗</a>
      <button class="quiet" @click="copy(instructions)">Copy instructions</button>
    </section>
    <section v-if="token" class="token-result" aria-label="New agent token">
      <p>Copy this token now. It is shown only once.</p>
      <code class="secret">{{ token }}</code>
      <button class="quiet" @click="copy(token, true)">{{ copied ? 'Copied' : 'Copy token' }}</button>
    </section>
    <details class="manual"><summary>Create a token manually</summary>
    <form @submit.prevent="create">
      <label>Token name<input v-model="name" autocomplete="off" required maxlength="100" :disabled="busy" /></label>
      <label class="creation"><input v-model="allowCreate" type="checkbox" :disabled="busy" />Allow creation of artifacts and libraries</label>
      <div class="scope-list" aria-label="Project permissions">
        <label v-for="project in projects" :key="project.id" class="scope-row">
          <span>{{ project.title }}<small>{{ project.ownerName }}</small></span>
          <select v-model="permissions[project.id]" :aria-label="`Agent permission for ${project.title}`" :disabled="busy">
            <option value="">No access</option>
            <option value="read">Read</option>
            <option v-if="project.permission === 'admin' || project.permission === 'write'" value="write">Write</option>
          </select>
        </label>
      </div>
      <button class="quiet" :disabled="busy || !name.trim()">Create token</button>
    </form>
    </details>
    <section class="existing" aria-label="Existing agent tokens">
      <h3>Tokens</h3>
      <p v-if="!busy && !grants.length">No tokens.</p>
      <div v-for="grant in grants" :key="grant.id" class="grant-row">
        <div><strong>{{ grant.name }}</strong><small>{{ grant.state }} · {{ grant.projects.length }} projects{{ grant.allowCreate ? ' · can create' : '' }}</small></div>
        <button v-if="grant.state !== 'revoked'" class="quiet" :disabled="busy" @click="revoke(grant.id)">{{ grant.state === 'revocation_pending' ? 'Retry revocation' : 'Revoke' }}</button>
      </div>
    </section>
    <p v-if="busy" role="status">Loading…</p>
    <p v-if="error" class="pane-error" role="alert">{{ error }}</p>
  </dialog>
</template>

<style scoped>
.agents-dialog { width: min(560px, calc(100vw - 40px)); max-height: calc(100vh - 40px); overflow: auto; }
.creation { display: flex; align-items: center; gap: 9px; }
.creation input { width: auto; margin: 0; }
.scope-list { max-height: 230px; overflow: auto; margin-bottom: 16px; }
.scope-row, .grant-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.scope-row span, .grant-row div { min-width: 0; overflow-wrap: anywhere; }
.scope-row select { width: 116px; margin: 0; flex-shrink: 0; }
small { display: block; color: var(--muted); margin-top: 4px; font-size: 11px; }
.existing, .manual { border-top: 1px solid var(--border); margin-top: 24px; padding-top: 18px; }
summary { cursor: pointer; }
.instructions { margin-bottom: 24px; }
.instructions a { text-decoration: underline; margin-right: 12px; }
h3 { font-size: 13px; margin: 0 0 12px; font-weight: 700; }
.grant-row { padding: 9px 0; font-size: 12px; }
.token-result { padding: 16px; border-radius: 8px; background: var(--panel); margin-bottom: 18px; }
.token-result p { margin: 0 0 10px; font-size: 12px; }
.secret { display: block; overflow-wrap: anywhere; user-select: all; margin-bottom: 12px; font-size: 12px; }
</style>
