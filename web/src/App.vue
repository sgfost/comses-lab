<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick, watch, defineAsyncComponent } from "vue";
import type { Project, User } from "../../shared/contracts";
import { api, demoMode } from "./api";
import ProjectCard from "./components/ProjectCard.vue";
import Workspace from "./components/Workspace.vue";
import ProjectDialog from "./components/ProjectDialog.vue";
import GroupsDialog from "./components/GroupsDialog.vue";
import AgentTokens from "./components/AgentTokens.vue";
import AgentConnect from "./components/AgentConnect.vue";
import SignInDialog from "./components/SignInDialog.vue";
const DemoToolbar = demoMode ? defineAsyncComponent(() => import("./components/DemoToolbar.vue")) : undefined;
const assetBase = import.meta.env.BASE_URL;
async function prepareDemoAction() { return await workspace.value?.confirmLeave() ?? true; }
const user = ref<User | null>(null);
const headerQuery = matchMedia("(max-width: 650px)");
const compactHeader = ref(headerQuery.matches);
const accountMenu = ref<HTMLDetailsElement>();
const updateCompactHeader = () => { compactHeader.value = headerQuery.matches; };
function closeAccountMenu(restoreFocus = false) {
  if (!compactHeader.value || !accountMenu.value) return;
  accountMenu.value.open = false;
  if (restoreFocus) accountMenu.value.querySelector("summary")?.focus();
}
function dismissAccountMenu(event: PointerEvent) {
  if (!accountMenu.value?.contains(event.target as Node)) closeAccountMenu();
}
const projects = ref<Project[]>([]);
const project = ref<Project | null>(null);
const initialRef = ref("");
const initialBranch = ref("");
const showCreate = ref(false);
const createKind = ref<"model" | "library">("model");
const kind = ref("model");
const searchAcross = ref(false);
const space = ref<"explore" | "mine">("explore");
const catalogRoutes = ref<Record<string, string>>({});
const lastExplore = ref("#/explore/artifacts");
const showGroups = ref(false);
const showAgents = ref(false);
const agentLoginCode = ref<string | null>(null);
let acceptedHash = location.hash;
let guarding = false;
const loading = ref(true);
const error = ref("");
const search = ref("");
const visibility = ref("all");
const showLogin = ref(false);
let afterSignIn: { route: string; run: () => void } | undefined;
function requestSignIn(action?: () => void) {
  afterSignIn = action ? { route: location.hash, run: action } : undefined;
  loginError.value = "";
  showLogin.value = true;
}
function closeSignIn() {
  showLogin.value = false;
  afterSignIn = undefined;
}
const loginBusy = ref(false);
const loginError = ref("");
const workspace = ref<InstanceType<typeof Workspace>>();
let navigation = 0;
let request: AbortController | undefined;
const filteredProjects = computed(() =>
  projects.value.filter(
    (item) =>
      (space.value === "explore" ? item.visibility === "public" : !!user.value && (item.ownerId === user.value.id || item.sharedWithMe)) &&
      ((searchAcross.value && search.value.trim()) || (item.kind ?? "model") === kind.value) &&
      (visibility.value === "all" || item.visibility === visibility.value) &&
      `${item.title} ${item.description} ${item.ownerName}`
        .toLowerCase()
        .includes(search.value.trim().toLowerCase()),
  ),
);
const filtered = computed(() => !!search.value.trim() || visibility.value !== "all" || searchAcross.value);
function catalogLink(target = kind.value) {
  const query = new URLSearchParams();
  if (search.value.trim()) query.set("q", search.value.trim());
  if (visibility.value !== "all") query.set("visibility", visibility.value);
  if (searchAcross.value) query.set("scope", "all");
  return `#/${space.value}/${target === "library" ? "libraries" : "artifacts"}${query.size ? `?${query}` : ""}`;
}
function destination(area: "explore" | "mine", target = "model") {
  return area === "explore" ? lastExplore.value : catalogRoutes.value[`${area}/${target}`] || `#/mine/${target === "library" ? "libraries" : "artifacts"}`;
}
function rememberCatalog() {
  const url = catalogLink();
  catalogRoutes.value[`${space.value}/${kind.value}`] = url;
  if (space.value === "explore") lastExplore.value = url;
  return url;
}
function clearFilters() {
  search.value = "";
  visibility.value = "all";
  searchAcross.value = false;
}
watch([search, visibility, searchAcross], () => {
  if (project.value || agentLoginCode.value !== null || loading.value) return;
  history.replaceState(null, "", rememberCatalog());
  acceptedHash = location.hash;
});
function rememberRevision() { acceptedHash = location.hash; }
async function hashNavigate() {
  if (guarding) { history.replaceState(null, "", acceptedHash); return; }
  const target = location.hash;
  if (workspace.value) {
    history.replaceState(null, "", acceptedHash);
    guarding = true;
    const allowed = await workspace.value.confirmLeave();
    guarding = false;
    if (!allowed) return;
    history.replaceState(null, "", target);
  }
  acceptedHash = target;
  await navigate();
}
function created(result: import("../../shared/contracts").CreateProjectResponse) {
  location.hash = `/project/${result.project.id}?${new URLSearchParams({ ref: result.commit, branch: result.ref, edit: "1" })}`;
}
async function navigate() {
  const generation = ++navigation;
  request?.abort();
  request = new AbortController();
  const signal = request.signal;
  loading.value = true;
  error.value = "";
  project.value = null;
  agentLoginCode.value = null;
  try {
    const [path, query] = location.hash.slice(1).split("?");
    if (!demoMode && path === "/agents/connect") {
      agentLoginCode.value = new URLSearchParams(query).get("code") ?? "";
      return;
    }
    const id = path?.match(/^\/project\/([^/]+)$/)?.[1];
    if (id) {
      const result = await api<{ project: Project }>(
        `/projects/${encodeURIComponent(id)}`,
        { signal },
      );
      if (generation !== navigation) return;
      initialRef.value = new URLSearchParams(query).get("ref") ?? "";
      initialBranch.value = new URLSearchParams(query).get("branch") ?? "";
      project.value = result.project;
    } else {
      space.value = path?.startsWith("/mine") || ((!path || path === "/") && user.value && !demoMode) ? "mine" : "explore";
      kind.value = path?.endsWith("/libraries") ? "library" : "model";
      const filters = new URLSearchParams(query);
      search.value = filters.get("q") ?? "";
      visibility.value = space.value === "mine" && user.value && ["public", "private"].includes(filters.get("visibility") ?? "") ? filters.get("visibility")! : "all";
      searchAcross.value = space.value === "explore" && filters.get("scope") === "all";
      rememberCatalog();
      const result = await api<{ projects: Project[] }>("/projects", {
        signal,
      });
      if (generation === navigation) projects.value = result.projects;
    }
  } catch (cause) {
    if (generation === navigation && !signal.aborted)
      error.value = (cause as Error).message;
  } finally {
    if (generation === navigation) loading.value = false;
  }
}
async function signIn(username: string, password: string) {
  loginBusy.value = true;
  loginError.value = "";
  try {
    user.value = (
      await api<{ user: User }>("/session", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      })
    ).user;
    const continuation = afterSignIn;
    closeSignIn();
    if (!project.value) await navigate();
    else project.value = (await api<{ project: Project }>(`/projects/${project.value.id}`)).project;
    await nextTick();
    if (continuation?.route === location.hash) continuation.run();
  } catch (cause) {
    loginError.value = (cause as Error).message;
  } finally {
    loginBusy.value = false;
  }
}
async function signOut() {
  closeAccountMenu();
  if (guarding || !(await workspace.value?.confirmLeave() ?? true)) return;
  try {
    await workspace.value?.stop();
    await api("/session", { method: "DELETE" });
    showGroups.value = false;
    showAgents.value = false;
    user.value = null;
    visibility.value = "all";
    project.value = null;
    if (agentLoginCode.value !== null || location.hash === "#/explore") await navigate();
    else location.hash = "/explore";
  } catch (cause) {
    error.value = (cause as Error).message;
  }
}
onMounted(async () => {
  headerQuery.addEventListener("change", updateCompactHeader);
  document.addEventListener("pointerdown", dismissAccountMenu);
  window.addEventListener("hashchange", hashNavigate);
  try {
    user.value = (await api<{ user: User | null }>("/session")).user;
  } catch (cause) {
    error.value = (cause as Error).message;
  }
  await navigate();
});
onUnmounted(() => {
  headerQuery.removeEventListener("change", updateCompactHeader);
  document.removeEventListener("pointerdown", dismissAccountMenu);
  request?.abort();
  window.removeEventListener("hashchange", hashNavigate);
});
</script>
<template>
  <div class="app-shell">
    <header class="topbar">
      <a href="#/" class="brand" aria-label="Comses lab home">
        <img :src="`${assetBase}branding/comses-mark.png`" alt="" width="44" height="44" />
        <span>Comses lab</span>
      </a>
      <span v-if="project" class="crumb"
        >/ <span>{{ project.title }}</span></span
      >
      <details v-if="user && !demoMode" ref="accountMenu" class="account-menu" :open="!compactHeader" @keydown.esc.stop.prevent="closeAccountMenu(true)">
        <summary role="button" aria-label="Account menu">Account</summary>
        <div class="top-actions">
          <span class="identity">{{ user.displayName }}</span>
          <button class="quiet" @click="showGroups = true; closeAccountMenu(true)">Groups</button>
          <button class="quiet" @click="showAgents = true; closeAccountMenu(true)">Agents</button>
          <button class="quiet" @click="signOut">Sign out</button>
        </div>
      </details>
      <button v-else-if="!demoMode" class="quiet sign-in" @click="requestSignIn()">Sign in</button>
    </header>
    <DemoToolbar v-if="demoMode" :prepare="prepareDemoAction" />
    <div class="app-body">
      <nav class="app-nav" aria-label="Main navigation">
        <a :href="destination('explore')" :aria-current="!project && space === 'explore' ? 'page' : undefined">Explore</a>
        <span class="nav-section">Workspace</span>
        <a :href="destination('mine', 'model')" :aria-current="!project && space === 'mine' && kind === 'model' ? 'page' : undefined">My artifacts</a>
        <a :href="destination('mine', 'library')" :aria-current="!project && space === 'mine' && kind === 'library' ? 'page' : undefined">My libraries</a>
      </nav>
      <div class="app-content">
    <div v-if="error" role="alert" class="error-banner">
      {{ error }} <button @click="navigate">Retry</button>
    </div>
    <AgentConnect v-if="agentLoginCode !== null" :key="agentLoginCode" :code="agentLoginCode" :user="user" @sign-in="requestSignIn" />
    <Workspace
      v-else-if="project"
      :key="project.id"
      ref="workspace"
      :project="project"
      :initial-ref="initialRef"
      :initial-branch="initialBranch"
      :user="user"
      @sign-in="requestSignIn"
      @revision="rememberRevision"
      @created="created"
      @updated="project = $event"
    />
    <main v-else class="explore-page">
      <nav v-if="space === 'explore'" class="catalog-nav" aria-label="Explore public projects">
        <a :href="catalogLink('model')" :aria-current="kind === 'model' ? 'page' : undefined">Artifacts</a>
        <a :href="catalogLink('library')" :aria-current="kind === 'library' ? 'page' : undefined">Libraries</a>
      </nav>
      <div class="catalog-toolbar">
        <h1>
          {{ searchAcross && search.trim() ? "Search results" : space === "mine" ? kind === "library" ? "My libraries" : "My artifacts" : kind === "library" ? "Libraries" : "Artifacts" }} <span>{{ filteredProjects.length }}</span><span v-if="space === 'explore'" class="catalog-public">{{ demoMode ? "Examples & local projects" : "Public" }}</span>
        </h1>
        <button class="quiet catalog-create" @click="createKind = kind === 'library' ? 'library' : 'model'; user ? showCreate = true : requestSignIn(() => showCreate = true)"><span aria-hidden="true">+</span>{{ kind === 'library' ? 'New library' : 'New artifact' }}</button>
      </div>
      <p v-if="space === 'mine' && user" class="catalog-context">{{ demoMode ? "Your projects in this browser. Fork an example or create a new one to get started." : "Owned by you or shared with you." }}</p>
      <div v-if="space === 'explore' || user" class="catalog-search">
        <div class="catalog-filters">
          <div class="search-field">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
            <input v-model="search" type="search" aria-label="Search catalog" :placeholder="kind === 'library' ? 'Search libraries' : 'Search artifacts'" />
          </div>
          <select
            v-if="space === 'mine' && user && !demoMode"
            v-model="visibility"
            aria-label="Project visibility"
          >
            <option value="all">Any visibility</option>
            <option value="public">Public</option>
            <option value="private">Private</option></select
          >
        </div>
        <label v-if="space === 'explore'" class="search-scope"><input v-model="searchAcross" type="checkbox" />Search both catalogs</label>
        <button v-if="filtered" class="quiet" @click="clearFilters">Clear filters</button>
      </div>
      <div v-if="space === 'mine' && !user" class="empty">
        <p>Sign in to see your artifacts and libraries.</p>
        <button class="quiet" @click="requestSignIn()">Sign in to your workspace</button>
      </div>
      <p v-else-if="loading" role="status" class="empty">Loading…</p>
      <div v-else-if="!error" class="model-list" :class="{ 'library-catalog': kind === 'library' }">
        <ProjectCard v-for="item in filteredProjects" :key="item.id" :project="item" />
        <p v-if="!filteredProjects.length" class="empty" role="status">{{ filtered ? "No results match these filters." : kind === "library" ? "No libraries yet." : "No artifacts yet." }}</p>
      </div>
    </main>
    <footer v-if="!project" class="statusbar"><span>Local</span></footer>
      </div>
    </div>
    <ProjectDialog :kind="createKind" :open="showCreate" @close="showCreate = false" @created="created" />
    <GroupsDialog v-if="user && !demoMode" :open="showGroups" @close="showGroups = false" @changed="workspace?.refreshAccess()" />
    <AgentTokens v-if="user && !demoMode" :open="showAgents" @close="showAgents = false" />
    <SignInDialog
      :open="showLogin"
      :busy="loginBusy"
      :error="loginError"
      @close="closeSignIn"
      @submit="signIn"
    />
  </div>
</template>
