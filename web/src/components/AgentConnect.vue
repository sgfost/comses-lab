<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import type { AgentLoginRequest, Project, User } from "../../../shared/contracts";
import { api } from "../api";

const props = defineProps<{ code: string; user: User | null }>();
const emit = defineEmits<{ "sign-in": [] }>();
const enteredCode = ref(props.code);
const request = ref<AgentLoginRequest | null>(null);
const projects = ref<Project[]>([]);
const permissions = ref<Record<string, "" | "read" | "write">>({});
const name = ref("");
const allowCreate = ref(false);
const matched = ref(false);
const busy = ref(false);
const error = ref("");
const now = ref(Date.now());
const expired = computed(() => !!request.value && request.value.expiresAt <= now.value);
const missingScopes = computed(() => request.value?.projects.filter(scope => !projects.value.some(project => project.id === scope.projectId)).length ?? 0);
let generation = 0;
let controller: AbortController | undefined;
const timer = setInterval(() => { now.value = Date.now(); }, 1000);
watch(() => [props.code, props.user?.id], async () => {
  const current = ++generation;
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  request.value = null;
  projects.value = [];
  permissions.value = {};
  matched.value = false;
  error.value = "";
  busy.value = false;
  if (!props.code || !props.user) return;
  busy.value = true;
  try {
    const [login, catalog] = await Promise.all([
      api<{ request: AgentLoginRequest }>(`/agent-login/requests/${encodeURIComponent(props.code)}`, { signal }),
      api<{ projects: Project[] }>("/projects", { signal }),
    ]);
    if (current !== generation) return;
    request.value = login.request;
    name.value = login.request.name;
    allowCreate.value = login.request.allowCreate;
    const requestedIds = new Set(login.request.projects.map(scope => scope.projectId));
    projects.value = catalog.projects.sort((a, b) => Number(requestedIds.has(b.id)) - Number(requestedIds.has(a.id)));
    permissions.value = Object.fromEntries(catalog.projects.map(project => {
      const requested = login.request.projects.find(scope => scope.projectId === project.id)?.permission ?? "";
      return [project.id, requested === "write" && project.permission === "read" ? "read" : requested];
    }));
  } catch (cause) { if (current === generation && !signal.aborted) error.value = (cause as Error).message; }
  finally { if (current === generation) busy.value = false; }
}, { immediate: true });
function enterCode() {
  location.hash = `/agents/connect?${new URLSearchParams({ code: enteredCode.value.trim() })}`;
}
async function decide(decision: "approve" | "deny") {
  if (busy.value || expired.value || !request.value || (decision === "approve" && !matched.value)) return;
  const current = generation;
  busy.value = true;
  error.value = "";
  try {
    const fields = decision === "deny" ? { decision } : {
      decision, name: name.value, allowCreate: allowCreate.value,
      projects: Object.entries(permissions.value).filter(([, permission]) => permission).map(([projectId, permission]) => ({ projectId, permission })),
    };
    const result = await api<{ state: AgentLoginRequest["state"] }>(`/agent-login/requests/${encodeURIComponent(props.code)}`, { method: "POST", body: JSON.stringify(fields) });
    if (current === generation && request.value) request.value.state = result.state;
  } catch (cause) { if (current === generation) error.value = (cause as Error).message; }
  finally { if (current === generation) busy.value = false; }
}
onUnmounted(() => { generation++; controller?.abort(); clearInterval(timer); });
</script>

<template>
  <main class="agent-connect">
    <section class="approval" aria-labelledby="connect-title">
      <h1 id="connect-title">Connect an agent</h1>
      <form v-if="!code" @submit.prevent="enterCode">
        <label>Code from your agent<input v-model="enteredCode" autocomplete="off" required maxlength="20" /></label>
        <button class="primary">Continue</button>
      </form>
      <template v-else-if="!user">
        <code class="verification-code">{{ code }}</code>
        <button class="primary" @click="emit('sign-in')">Sign in to approve</button>
      </template>
      <template v-else-if="request">
        <template v-if="request.state === 'approved' || request.state === 'consumed'">
          <p role="status">Access approved. Return to your agent.</p>
          <a class="quiet" href="#/explore">Back to artifacts</a>
        </template>
        <p v-else-if="request.state === 'denied'" role="status">Access denied.</p>
        <p v-else-if="expired" role="alert">This request expired. Ask your agent to start again.</p>
        <form v-else @submit.prevent="decide('approve')">
          <p>Approving as <strong>{{ user.displayName }}</strong> <span class="muted">@{{ user.username }}</span></p>
          <code class="verification-code">{{ request.userCode }}</code>
          <label class="check"><input v-model="matched" type="checkbox" :disabled="busy" />This matches the code shown by my agent</label>
          <label>Agent name<input v-model="name" required maxlength="120" :disabled="busy" /></label>
          <label class="check"><input v-model="allowCreate" type="checkbox" :disabled="busy" />Allow creation of artifacts and libraries</label>
          <h2>Project access</h2>
          <p v-if="missingScopes" class="muted">{{ missingScopes }} requested project(s) are unavailable to this account.</p>
          <div class="scope-list" aria-label="Project permissions">
            <label v-for="project in projects" :key="project.id" class="scope-row">
              <span>{{ project.title }}<small>{{ project.ownerName }}</small></span>
              <select v-model="permissions[project.id]" :aria-label="`Agent permission for ${project.title}`" :disabled="busy">
                <option value="">No access</option><option value="read">Read</option>
                <option v-if="project.permission === 'admin' || project.permission === 'write'" value="write">Write</option>
              </select>
            </label>
          </div>
          <p class="muted">Revoke access any time from Agents.</p>
          <div class="actions">
            <button class="primary" :disabled="busy || !matched || !name.trim()">Allow access</button>
            <button class="quiet" type="button" :disabled="busy" @click="decide('deny')">Deny</button>
          </div>
        </form>
      </template>
      <p v-if="busy" role="status">Loading…</p>
      <p v-if="error" role="alert" class="pane-error">{{ error }}</p>
    </section>
  </main>
</template>

<style scoped>
.agent-connect { flex: 1; overflow: auto; padding: 52px 24px; }
.approval { max-width: 560px; margin: 0 auto; }
h1 { font-size: 32px; font-weight: 700; margin: 0 0 28px; }
h2 { font-size: 13px; font-weight: 700; margin: 28px 0 8px; }
.verification-code { display: block; font-size: 27px; letter-spacing: 3px; margin: 24px 0 16px; }
label { display: block; margin: 18px 0; }
input:not([type="checkbox"]) { display: block; width: 100%; margin-top: 8px; padding: 10px; background: var(--panel); color: var(--text); border: 0; border-radius: 8px; }
.check { display: flex; align-items: center; gap: 9px; }
.check input { margin: 0; }
.scope-list { max-height: 280px; overflow: auto; border-block: 1px solid var(--border); }
.scope-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; margin: 0; }
.scope-row span { min-width: 0; overflow-wrap: anywhere; }
select { padding: 6px; border: 0; border-radius: 8px; background: var(--panel); color: var(--text); }
small { display: block; margin-top: 4px; color: var(--muted); font-size: 11px; }
.muted { color: var(--muted); }
.actions { display: flex; gap: 12px; margin-top: 24px; }
.primary { background: var(--button); color: var(--button-text); padding: 10px 18px; }
</style>
