<script setup lang="ts">
import {
  ref,
  reactive,
  computed,
  onMounted,
  onUnmounted,
  watch,
  defineAsyncComponent,
  nextTick,
} from "vue";
import type {
  Project,
  User,
  SourceTree,
  RefKind,
  RefList,
  CommitHistory,
  CommitDiff,
  ProjectAccessResponse,
  CommitResponse,
  FileChange,
  Draft,
} from "../../../shared/contracts";
import { api, ApiRequestError, demoMode } from "../api";
import { useModelPreview } from "../composables/useModelPreview";
import { useFileBuffers } from "../composables/useFileBuffers";
import ProjectAccess from "./ProjectAccess.vue";
import DiscardDialog from "./DiscardDialog.vue";
import ProjectDialog from "./ProjectDialog.vue";
import LibraryUsage from "./LibraryUsage.vue";
import ProjectLibraries from "./ProjectLibraries.vue";
import PaneDivider from "./PaneDivider.vue";
const SourceEditor = defineAsyncComponent(() => import("./SourceEditor.vue"));
const NetLogoSourceEditor = defineAsyncComponent(() => import("./NetLogoSourceEditor.vue"));
import FileTree from "./FileTree.vue";
import DiffView from "./DiffView.vue";
const props = defineProps<{
  project: Project;
  initialRef: string;
  initialBranch: string;
  user: User | null;
}>();
const emit = defineEmits<{ "sign-in": [action?: () => void]; revision: []; created: [result: import("../../../shared/contracts").CreateProjectResponse]; updated: [project: Project] }>();
const tree = ref<SourceTree | null>(null);
const selectedRef = ref(props.initialRef);
const revisionLoading = ref(false);
const revisionError = ref("");
const requestedLibrary = ref(new URLSearchParams(location.hash.split("?")[1]).get("library") ?? "");
const initialCodeView = new URLSearchParams(location.hash.split("?")[1]).get("edit");
let sourceViewChosen = initialCodeView !== null;
const sourceOpen = ref(initialCodeView !== "0" && (initialCodeView === "1" || !props.project.entrypoint || props.project.kind === "library" || !!props.user && ["write", "admin"].includes(props.project.permission)));
const narrowQuery = matchMedia("(max-width: 650px)");
const narrow = ref(narrowQuery.matches);
const updateNarrow = () => { narrow.value = narrowQuery.matches; };
const workspaceViews = ref<HTMLElement>();
const sidebarPanel = ref<HTMLElement>();
const sidebar = ref<"files" | "history" | "about" | "">(!narrow.value ? "files" : "");
const workingRef = ref(props.initialBranch);
const workingHead = ref("");
const restoring = ref(false);
const restoreDialog = ref<HTMLDialogElement>();
const restoreError = ref("");
const ancestor = ref<Project | null>(null);
const sidebarWidth = ref(232);
const codeWidth = ref(52);
const consoleHeight = ref(160);
const consoleOpen = ref(false);
const buffers = useFileBuffers();
const netlogoAuthoring = ref(false);
const netlogoDirty = ref(false);
const netlogoSaving = ref(false);
const netlogoPreparing = ref(false);
const netlogoError = ref("");
const netlogoConversion = ref<HTMLDialogElement>();
let netlogoTimer: ReturnType<typeof setTimeout> | undefined;
let netlogoEdits = 0;
let capturingNetlogo: Promise<boolean> | undefined;
const draft = ref<Draft | null>(null);
const draftReady = ref(false);
const draftStatus = ref("Draft saved");
const draftError = ref("");
const draftConflict = ref(false);
const recovery = ref<string | null>(null);
let acknowledged = "[]";
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let savingDraft: Promise<boolean> | undefined;
const recoveryKey = computed(() => `lab-draft:${demoMode ? new URL(import.meta.env.BASE_URL, document.baseURI).pathname + ":" : ""}${props.user?.id ?? ""}:${props.project.id}`);
const pendingSave = ref<{ expectedVersion: number; submitted: ReturnType<typeof buffers.snapshot>; message: string } | null>(null);
watch(recovery, value => {
  if (!props.user) return;
  try { if (value) localStorage.setItem(`${recoveryKey.value}:recovery`, value); else localStorage.removeItem(`${recoveryKey.value}:recovery`); } catch {}
});
function rememberDraft() {
  if (!props.user || !draftReady.value || !branch.value || JSON.stringify(draftChanges.value) === acknowledged) return;
  try {
    localStorage.setItem(recoveryKey.value, JSON.stringify({ version: draft.value?.version ?? 0, baseCommit: tree.value?.commit, changes: draftChanges.value }));
  } catch { /* The server draft still works when browser storage is unavailable. */ }
}
async function flushDraft(): Promise<boolean> {
  clearTimeout(autosaveTimer);
  if (savingDraft) { if (!(await savingDraft)) return false; return flushDraft(); }
  if (!branch.value) return true;
  if (pendingSave.value || draft.value?.savingCommit) return false;
  if (!draftReady.value || !branch.value || !tree.value || draftConflict.value) return !draftConflict.value;
  if (JSON.stringify(draftChanges.value) === acknowledged) return true;
  const ref = branch.value, baseCommit = tree.value.commit;
  savingDraft = (async () => {
    while (JSON.stringify(draftChanges.value) !== acknowledged && !draftConflict.value) {
      const changes = draftChanges.value;
      const serialized = JSON.stringify(changes);
      draftStatus.value = "Saving draft…";
      try {
        const result = await api<{ draft: Draft }>(`${projectPath}/draft`, { method: "PUT", body: JSON.stringify({ expectedVersion: draft.value?.version ?? 0, ref, baseCommit, changes }) });
        draft.value = result.draft;
        acknowledged = serialized;
        draftStatus.value = "Draft saved";
        draftError.value = "";
        if (JSON.stringify(draftChanges.value) === acknowledged) { try { localStorage.removeItem(recoveryKey.value); } catch {} }
      } catch (cause) {
        draftStatus.value = "Couldn’t save draft";
        draftError.value = (cause as Error).message;
        draftConflict.value = cause instanceof ApiRequestError && cause.detail.code === "stale_draft";
        rememberDraft();
        return false;
      }
    }
    return true;
  })();
  try { return await savingDraft; } finally { savingDraft = undefined; }
}
function downloadRecovery() {
  const contents = recovery.value ?? JSON.stringify({ baseCommit: tree.value?.commit, changes: draftChanges.value }, null, 2);
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `${props.project.forgejoRepo || props.project.id}-draft.json`; link.click(); URL.revokeObjectURL(url);
}
async function hydrateDraft(value: Draft | null, isCurrent = () => true) {
  const base = value ? await api<SourceTree>(`${projectPath}/tree?ref=${value.baseCommit}`) : tree.value;
  const files = value ? await Promise.all(value.changes.map(async change => {
    let original: string | null | undefined = null;
    if (change.operation === "update") original = (await api<{ content: string }>(`${projectPath}/file?commit=${value.baseCommit}&path=${encodeURIComponent(change.path)}`)).content;
    else if (change.operation === "delete") original = undefined;
    return { path: change.path, original, content: change.operation === "delete" ? null : change.content };
  })) : [];
  if (!isCurrent()) return;
  draftReady.value = false;
  buffers.files.clear();
  draft.value = value;
  if (value) { branch.value = value.ref; workingRef.value = value.ref; tree.value = base; }
  for (const file of files) buffers.files.set(file.path, { original: file.original, content: file.content });
  acknowledged = JSON.stringify(draftChanges.value);
  draftConflict.value = false;
  draftError.value = "";
  draftStatus.value = "Draft saved";
  pendingSave.value = value?.savingCommit ? { expectedVersion: value.version, submitted: buffers.snapshot(), message: "" } : null;
  draftReady.value = true;
}
async function reloadServerDraft() {
  if (committing.value || restoring.value || libraryBusy.value || revisionLoading.value || netlogoPreparing.value) return;
  netlogoPreparing.value = true;
  clearTimeout(netlogoTimer);
  clearTimeout(autosaveTimer);
  try {
    if (capturingNetlogo) await capturingNetlogo;
    if (savingDraft) await savingDraft;
    let recovered = draftChanges.value;
    if (netlogoAuthoring.value) {
      setNetlogoAuthoring(false);
      const file = buffers.files.get(props.project.entrypoint);
      if (!file) throw new Error("Open the model source before recovering interface edits.");
      const content = await exportNetlogo();
      const document = new DOMParser().parseFromString(content, "application/xml");
      if (document.querySelector("parsererror") || document.documentElement.tagName !== "model") throw new Error("NetLogo returned an invalid model file.");
      // Preserve the export outside live buffers so recovery never autosaves over
      // the server draft being recovered.
      recovered = [...recovered.filter(change => change.path !== props.project.entrypoint), { operation: file.original === null ? "create" : "update", path: props.project.entrypoint, content }];
      netlogoAuthoring.value = false;
      netlogoDirty.value = false;
      netlogoError.value = "";
    }
    if (JSON.stringify(recovered) !== acknowledged || pendingSave.value) {
      recovery.value = JSON.stringify({ baseCommit: tree.value?.commit, changes: recovered }, null, 2);
      try {
        localStorage.setItem(`${recoveryKey.value}:recovery`, recovery.value);
        localStorage.removeItem(recoveryKey.value);
      } catch { /* Keep the in-memory recovery copy when storage is unavailable. */ }
    }
    draftReady.value = false;
    draftConflict.value = false;
    await stopPreview();
    await loadRevision(workingRef.value, false, "", true);
  } catch (cause) {
    netlogoError.value = (cause as Error).message;
    if (netlogoAuthoring.value) setNetlogoAuthoring(true);
  } finally {
    netlogoPreparing.value = false;
    if (!launch.value && canRun.value && props.user) void run();
  }
}

const discardDialog = ref<InstanceType<typeof DiscardDialog>>();
const branch = ref(props.initialBranch);
const committing = ref(false);
const commitMessage = ref("");
const commitError = ref("");
const conflict = ref<string | null | undefined>();
const inspecting = ref(false);
const inspectedHead = ref<string | null | undefined>();
const newPath = ref("");
const fileError = ref("");
const showFork = ref(false);
const showExtraction = ref(false);
const libraryBusy = ref(false);
const libraryHydrating = ref(false);
const metadataEditing = ref(false);
const metadataBusy = ref(false);
const metadataError = ref("");
const metadata = reactive({ title: "", description: "", license: "", entrypoint: "" });
const owner = computed(() => props.user?.id === props.project.ownerId);
const accessStatus = ref<ProjectAccessResponse | null>(null);
const accessError = ref("");
let accessRequest = 0;
const accessBlocked = computed(() => owner.value && (!accessStatus.value || accessStatus.value.effective.mode !== "normal"));
async function refreshAccess() {
  const request = ++accessRequest;
  if (!owner.value) { accessStatus.value = null; return; }
  accessError.value = "";
  try {
    const status = await api<ProjectAccessResponse>(`/projects/${props.project.id}/access`);
    if (disposed || request !== accessRequest || !owner.value) return;
    accessStatus.value = status;
    const result = await api<{ project: Project }>(`/projects/${props.project.id}`);
    if (!disposed && request === accessRequest && owner.value) emit("updated", result.project);
  }
  catch (cause) { if (!disposed && request === accessRequest && owner.value) accessError.value = (cause as Error).message; }
}
const metadataOrigins = ref("");
let metadataVersion = 0;
const editable = computed(() => !!props.user && ["write", "admin"].includes(props.project.permission) && branch.value.startsWith("refs/heads/") && draftReady.value && !revisionLoading.value && !accessBlocked.value && !libraryBusy.value);
const source = computed(() => buffers.files.get(selected.value)?.content ?? "");
const visibleFiles = computed(() => {
  const paths = new Set(tree.value?.files.map(file => file.path));
  for (const [path, file] of buffers.files) {
    if (file.content === null) paths.delete(path);
    else paths.add(path);
  }
  return [...paths].sort().map(path => ({ path }));
});
async function confirmLeave() {
  if (committing.value || marimoSaving.value || restoring.value || metadataBusy.value || libraryBusy.value) return false;
  if (!(await finishMarimo()) || !(await finishNetlogo())) return false;
  if (!metadataEditing.value && await flushDraft()) return true;
  return await discardDialog.value?.confirm() ?? false;
}
function updateSource(content: string) {
  const file = buffers.files.get(selected.value);
  if (editable.value && !(marimoEditing.value && selected.value === previewPath.value) && !netlogoAuthoring.value && !netlogoPreparing.value && file) file.content = content;
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (marimoEditing.value || netlogoAuthoring.value || netlogoDirty.value || netlogoSaving.value || (draftReady.value && JSON.stringify(draftChanges.value) !== acknowledged) || committing.value || libraryBusy.value || metadataEditing.value) { event.preventDefault(); event.returnValue = ""; }
}
function createFile() {
  if (!editable.value || committing.value) return;
  const path = newPath.value;
  const parts = path.split("/");
  if (!path || path.length > 500 || /[\\\x00-\x1f\x7f]/.test(path) || parts.some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git") || visibleFiles.value.some(file => file.path === path) || [...(tree.value?.files ?? []), ...buffers.changed.value.map(([path]) => ({ path }))].some(file => file.path.startsWith(path + "/") || path.startsWith(file.path + "/"))) {
    fileError.value = "Enter a new relative file path without conflicting files."; return;
  }
  fileError.value = "";
  buffers.create(path);
  newPath.value = "";
  void openSidebarFile(path);
}
async function discardFile(path: string) {
  if (marimoEditing.value || committing.value || !(await discardDialog.value?.confirm(`Unsaved changes to ${path} will be lost.`))) return;
  buffers.discard(path);
  if (selected.value === path) {
    if (visibleFiles.value.some(file => file.path === path)) void selectFile(path);
    else { openFiles.value = openFiles.value.filter(file => file !== path); selected.value = ""; }
  }
}
function deleteFile() {
  if (!editable.value || committing.value || marimoEditing.value || !selected.value) return;
  const path = selected.value;
  buffers.remove(path);
  openFiles.value = openFiles.value.filter(item => item !== path);
  selected.value = "";
  const next = visibleFiles.value[0]?.path;
  if (next) void selectFile(next);
}
function writeUrl() {
  if (!tree.value) return;
  const query = new URLSearchParams({ ref: tree.value.commit });
  if (branch.value) query.set("branch", branch.value);
  query.set("edit", sourceOpen.value ? "1" : "0");
  history.replaceState(null, "", `#/project/${props.project.id}?${query}`);
  emit("revision");
}
async function commitChanges(andRun = false) {
  if (!(await finishMarimo())) return;
  if (netlogoAuthoring.value && !(await finishNetlogo())) return;
  if (!editable.value || committing.value || !tree.value || !buffers.dirty.value && !pendingSave.value) return;
  let submitted = buffers.snapshot();
  const note = commitMessage.value;
  const message = note.trim() || (submitted.length === 1 ? `Update ${submitted[0]!.path}` : `Update ${submitted.length} files`);
  committing.value = true;
  commitError.value = "";
  conflict.value = undefined;
  inspectedHead.value = undefined;
  try {
    if (!pendingSave.value) {
      if (!(await flushDraft())) return;
      submitted = buffers.snapshot();
      pendingSave.value = { expectedVersion: draft.value?.version ?? 0, submitted, message };
    }
    submitted = pendingSave.value.submitted;
    const result = await api<CommitResponse & { draft: Draft }>(`${projectPath}/draft/save`, { method: "POST", body: JSON.stringify({ expectedVersion: pendingSave.value.expectedVersion, message: pendingSave.value.message }) });
    draft.value = result.draft;
    pendingSave.value = null;
    acknowledged = "[]";
    draftConflict.value = false;
    draftError.value = "";
    buffers.applied(submitted);
    const files = new Map(tree.value.files.map(file => [file.path, file]));
    for (const file of submitted) {
      if (file.content === null) files.delete(file.path);
      else files.set(file.path, { path: file.path, size: new TextEncoder().encode(file.content).length });
    }
    tree.value = { commit: result.commit, files: [...files.values()] };
    workingHead.value = result.commit;
    writeUrl();
    if (sourceState.value === "loading" && selected.value) void selectFile(selected.value);
    histories.value = null;
    diff.value = null;
    if (commitMessage.value === note) commitMessage.value = "";
    if (andRun) await runSaved();
  } catch (cause) {
    const unknown = !(cause instanceof ApiRequestError) || cause.detail.code === "save_outcome_unknown" || cause.status < 400;
    commitError.value = unknown
      ? "Save outcome unknown. Retry Save version to finish it."
      : cause.message;
    if (!unknown && !(cause instanceof ApiRequestError && cause.detail.code === "draft_busy")) pendingSave.value = null;
    if (cause instanceof ApiRequestError && cause.detail.code === "stale_head") conflict.value = cause.detail.currentCommit;
  } finally { committing.value = false; }
}
async function libraryDrafted(result: { draft: Draft }) {
  libraryHydrating.value = true;
  libraryBusy.value = true;
  draftReady.value = false;
  try {
    await hydrateDraft(result.draft);
    if (selected.value) await selectFile(selected.value);
  } catch (cause) { draftStatus.value = "Couldn’t save draft"; draftError.value = (cause as Error).message; }
  finally { libraryHydrating.value = false; libraryBusy.value = false; }
}
async function discardDraftForLatest() {
  if (!workingRef.value || committing.value || !(await discardDialog.value?.confirm("Discard this draft and use the latest saved version?"))) return;
  committing.value = true;
  commitError.value = "";
  try {
    if (!(await flushDraft())) return;
    draftReady.value = false;
    const latest = await api<SourceTree>(`${projectPath}/tree?ref=${encodeURIComponent(workingRef.value)}`);
    const result = await api<{ draft: Draft }>(`${projectPath}/draft`, { method: "PUT", body: JSON.stringify({ expectedVersion: draft.value?.version ?? 0, ref: workingRef.value, baseCommit: latest.commit, changes: [] }) });
    workingHead.value = latest.commit;
    await hydrateDraft(result.draft);
    openFiles.value = openFiles.value.filter(path => visibleFiles.value.some(file => file.path === path));
    const path = visibleFiles.value.find(file => file.path === selected.value)?.path ?? props.project.entrypoint ?? visibleFiles.value[0]?.path;
    selected.value = path || "";
    if (path) await selectFile(path);
    writeUrl();
    conflict.value = undefined;
    try { localStorage.removeItem(recoveryKey.value); } catch {}
  } catch (cause) { commitError.value = (cause as Error).message; }
  finally { committing.value = false; }
}
async function inspectBranch() {
  if (!branch.value || inspecting.value) return;
  inspecting.value = true;
  try { inspectedHead.value = (await api<SourceTree>(`${projectPath}/tree?ref=${encodeURIComponent(branch.value)}`)).commit; }
  catch (cause) { commitError.value = (cause as Error).message; }
  finally { inspecting.value = false; }
}
function editMetadata() {
  if (revisionLoading.value || committing.value || marimoEditing.value || accessBlocked.value) return;
  Object.assign(metadata, { title: props.project.title, description: props.project.description, license: props.project.license, entrypoint: props.project.entrypoint });
  metadataOrigins.value = props.project.dataOrigins.join("\n");
  metadataVersion = props.project.metadataVersion;
  metadataError.value = "";
  metadataEditing.value = true;
}
async function saveMetadata() {
  if (metadataBusy.value) return;
  metadataBusy.value = true;
  metadataError.value = "";
  try {
    const result = await api<{ project: Project }>(projectPath, { method: "PATCH", body: JSON.stringify({ expectedMetadataVersion: metadataVersion, ...metadata, dataOrigins: metadataOrigins.value.split(/\r?\n/).map(origin => origin.trim()).filter(Boolean) }) });
    emit("updated", result.project);
    metadataEditing.value = false;
  } catch (cause) { metadataError.value = (cause as Error).message; }
  finally { metadataBusy.value = false; }
}
const selected = ref("");
const openFiles = ref<string[]>([]);
const sourceState = ref<"loading" | "ready" | "error">("loading");
const sourceError = ref("");
const contentView = ref<"source" | "diff">("source");
const fileTabs = ref<HTMLElement>();
const sourceEditor = ref<InstanceType<typeof SourceEditor>>();
let focusSelectedSource = false;
function focusOpenedSource() {
  if (!focusSelectedSource || !sourceEditor.value) return;
  sourceEditor.value.focus();
  focusSelectedSource = false;
}
watch(sourceEditor, focusOpenedSource, { flush: "post" });
const cursor = ref({ line: 1, column: 1 });
const histories = ref<CommitHistory | null>(null);
const historyLoading = ref(false);
const historyError = ref("");
const diff = ref<CommitDiff | null>(null);
const diffLoading = ref(false);
const diffError = ref("");
const showRefs = ref(false);
const refKind = ref<RefKind>("branch");
const refLists = reactive<Partial<Record<RefKind, RefList>>>({});
const refLoading = reactive<Record<RefKind, boolean>>({
  branch: false,
  tag: false,
});
const refErrors = reactive<Record<RefKind, string>>({ branch: "", tag: "" });
const revisionInput = ref("");
const workPanes = ref<HTMLElement>();
const panesWidth = ref(900);
const paneHeight = ref(700);
const notebookPath = ref("");
const previewPath = computed(() => notebookPath.value || props.project.entrypoint);
const marimoEditing = ref(false);
const marimoSaving = ref(false);
let marimoSource = "";
let marimoPath = "";
let marimoRevision = 0;
const notebookError = ref("");
async function finishMarimo(): Promise<boolean> {
  if (!marimoEditing.value || !launch.value) return true;
  if (marimoSaving.value) return false;
  marimoSaving.value = true;
  try {
    const id = launch.value.id, path = previewPath.value;
    const content = await exportMarimo();
    const file = buffers.files.get(path);
    if (path !== marimoPath || revisionGeneration !== marimoRevision || !editable.value || id !== launch.value?.id || path !== previewPath.value || !file || file.content !== marimoSource)
      throw new Error('Notebook source changed. Keep this notebook open and resolve the source conflict.');
    file.content = content;
    marimoSource = content;
    if (!(await flushDraft())) return false;
    return true;
  } catch (cause) { notebookError.value = (cause as Error).message; return false; }
  finally { marimoSaving.value = false; }
}
async function openNotebook(edit = false) {
  if (edit && metadataEditing.value) return;
  clearTimeout(previewTimer);
  if (!(await finishMarimo())) return;
  await stopPreview();
  marimoEditing.value = edit && editable.value;
  notebookError.value = "";
  if (marimoEditing.value) {
    await selectFile(previewPath.value);
    marimoSource = buffers.files.get(previewPath.value)?.content ?? "";
    marimoPath = previewPath.value;
    marimoRevision = revisionGeneration;
  }
  await runPreview();
}
const iframe = ref<HTMLIFrameElement>();
const livePreview = ref(true);
const previewSizing = ref("fit");
const effectivePreviewSizing = computed({
  get: () => netlogoAuthoring.value || /\.py$/i.test(previewPath.value) ? "actual" : previewSizing.value,
  set: (value: string) => { previewSizing.value = value; },
});
const draftChanges = computed<FileChange[]>(() => buffers.snapshot().map(file => file.content === null
  ? { operation: "delete", path: file.path }
  : { operation: file.original === null ? "create" : "update", path: file.path, content: file.content }));
let previewTimer: ReturnType<typeof setTimeout> | undefined;
const {
  launch,
  launching,
  stopping,
  error: launchError,
  lines: consoleLines,
  activity: events,
  run: runPreview,
  runSaved: runSavedPreview,
  stop: stopPreview,
  cancelPending,
  netlogoReady,
  netlogoNotice,
  exportNetlogo,
  exportMarimo,
  setNetlogoAuthoring,
  waitForNetlogo,
  setPreviewFit,
} = useModelPreview({
  projectId: props.project.id,
  iframe,
  commit: () => tree.value?.commit,
  signedIn: () => !!props.user,
  signIn: () => emit("sign-in"),
  changes: () => draftChanges.value,
  entrypoint: () => previewPath.value,
  marimoEdit: () => marimoEditing.value && editable.value,
  marimoSave: content => {
    if (!marimoEditing.value || !editable.value || committing.value) return;
    const file = buffers.files.get(previewPath.value);
    if (previewPath.value !== marimoPath || revisionGeneration !== marimoRevision || !file || file.content !== marimoSource) {
      notebookError.value = "Source changed outside the notebook. Reopen the notebook before saving further edits.";
      return;
    }
    file.content = content;
    marimoSource = content;
    if (launch.value) launch.value.draft = true;
  },
  netlogoChanged: () => {
    if (!netlogoAuthoring.value || netlogoPreparing.value || !editable.value) return;
    netlogoEdits++;
    netlogoDirty.value = true;
    clearTimeout(netlogoTimer);
    netlogoTimer = setTimeout(() => { void captureNetlogo(); }, 400);
  },
});
watch(effectivePreviewSizing, mode => setPreviewFit(mode === "fit"), { immediate: true });
const isNetlogo = computed(() => /\.nlogox?$/i.test(previewPath.value));
async function captureNetlogo(force = false): Promise<boolean> {
  clearTimeout(netlogoTimer);
  if (capturingNetlogo) { if (!(await capturingNetlogo)) return false; return captureNetlogo(force); }
  if (force && netlogoAuthoring.value) netlogoDirty.value = true;
  if (!netlogoDirty.value) return true;
  if (!editable.value || !netlogoReady.value) { netlogoError.value = "The interface edits have not been saved. Keep this preview open and retry."; return false; }
  capturingNetlogo = (async () => {
    netlogoSaving.value = true;
    try {
      while (netlogoDirty.value) {
        const id = launch.value?.id, revision = revisionGeneration, path = props.project.entrypoint;
        const changes = JSON.stringify(draftChanges.value), edits = netlogoEdits;
        const content = await exportNetlogo();
        if (id !== launch.value?.id || revision !== revisionGeneration || path !== props.project.entrypoint || changes !== JSON.stringify(draftChanges.value) || !editable.value)
          throw new Error("Source changed while the interface was being edited. Export the model from the preview before reloading.");
        const document = new DOMParser().parseFromString(content, "application/xml");
        if (document.querySelector("parsererror") || document.documentElement.tagName !== "model") throw new Error("NetLogo returned an invalid model file.");
        const file = buffers.files.get(path);
        if (!file || !/\.nlogox$/i.test(path)) throw new Error("Convert the model to .nlogox before editing its interface.");
        file.content = content;
        await nextTick();
        if (!(await flushDraft())) throw new Error(draftError.value || "Could not save the model draft");
        netlogoDirty.value = edits !== netlogoEdits;
      }
      netlogoError.value = "";
      return true;
    } catch (cause) { netlogoError.value = (cause as Error).message; return false; }
    finally { netlogoSaving.value = false; }
  })();
  try { return await capturingNetlogo; } finally { capturingNetlogo = undefined; }
}
async function finishNetlogo() {
  if (netlogoPreparing.value) return false;
  // Stop new edits and flush upstream mode-exit changes before the final export.
  if (netlogoAuthoring.value) setNetlogoAuthoring(false);
  if (!(await captureNetlogo(true))) { if (netlogoAuthoring.value) setNetlogoAuthoring(true); return false; }
  if (netlogoAuthoring.value) {
    netlogoAuthoring.value = false;
    setNetlogoAuthoring(false);
  }
  return true;
}
async function run() { if (await finishMarimo() && await finishNetlogo()) await runPreview(); }
async function runSaved() { if (await finishMarimo() && await finishNetlogo()) await runSavedPreview(); }
async function stop() { if (await finishMarimo() && await finishNetlogo()) { marimoEditing.value = false; await stopPreview(); } }
async function editNetlogoInterface() {
  if (!editable.value || !netlogoReady.value || netlogoSaving.value || netlogoPreparing.value) return;
  netlogoError.value = "";
  if (/\.nlogo$/i.test(props.project.entrypoint)) { netlogoConversion.value?.showModal(); return; }
  netlogoPreparing.value = true;
  try {
    await prepareNetlogo();
    netlogoAuthoring.value = true;
    sourceOpen.value = false;
    sidebar.value = "";
    setNetlogoAuthoring(true);
  } catch (cause) { netlogoError.value = (cause as Error).message; }
  finally { netlogoPreparing.value = false; }
}
async function prepareNetlogo() {
  clearTimeout(previewTimer);
  cancelPending();
  await selectFile(props.project.entrypoint);
  if (!editable.value || !(await flushDraft())) throw new Error(draftError.value || "Save the draft before editing the interface.");
  const revision = revisionGeneration, path = props.project.entrypoint, changes = JSON.stringify(draftChanges.value);
  // Visual edits must start from today's draft, even with live preview turned off.
  await runPreview();
  await waitForNetlogo();
  if (!editable.value || revision !== revisionGeneration || path !== props.project.entrypoint || changes !== JSON.stringify(draftChanges.value)) throw new Error("Source changed while the preview loaded. Try again.");
}
const canConvertNetlogo = computed(() => owner.value && branch.value === `refs/heads/${refLists.branch?.defaultBranch}`);
async function convertNetlogo() {
  if (!canConvertNetlogo.value || !editable.value || !netlogoReady.value || netlogoSaving.value || netlogoPreparing.value) return;
  netlogoSaving.value = true;
  netlogoPreparing.value = true;
  netlogoError.value = "";
  const live = livePreview.value;
  livePreview.value = false;
  try {
    await nextTick();
    await prepareNetlogo();
    const id = launch.value?.id, revision = revisionGeneration, original = props.project.entrypoint;
    const changes = JSON.stringify(draftChanges.value);
    const content = await exportNetlogo();
    if (id !== launch.value?.id || revision !== revisionGeneration || original !== props.project.entrypoint || changes !== JSON.stringify(draftChanges.value)) throw new Error("The source changed. Reload the preview before converting.");
    const document = new DOMParser().parseFromString(content, "application/xml");
    if (document.querySelector("parsererror") || document.documentElement.tagName !== "model") throw new Error("NetLogo returned an invalid model file.");
    const path = original.replace(/\.nlogo$/i, ".nlogox");
    if (visibleFiles.value.some(file => file.path === path)) throw new Error(`${path} already exists. Choose it as the entrypoint in About, or rename it before converting.`);
    buffers.create(path);
    buffers.files.get(path)!.content = content;
    commitMessage.value = `Convert ${original} to NetLogo XML`;
    await nextTick();
    await commitChanges();
    if (commitError.value || buffers.dirty.value || pendingSave.value) throw new Error(commitError.value || "Save the converted file before changing the entrypoint.");
    const result = await api<{ project: Project }>(projectPath, { method: "PATCH", body: JSON.stringify({ expectedMetadataVersion: props.project.metadataVersion, entrypoint: path }) });
    emit("updated", result.project);
    netlogoConversion.value?.close();
  } catch (cause) { netlogoError.value = (cause as Error).message; }
  finally { netlogoSaving.value = false; netlogoPreparing.value = false; livePreview.value = live; }
}
watch(netlogoReady, ready => { if (ready && netlogoAuthoring.value) setNetlogoAuthoring(true); });
const consoleTab = ref<"console" | "activity">("console");
const logFilter = ref("");
const filteredConsole = computed(() =>
  consoleLines.value.filter((line) =>
    line.text.toLowerCase().includes(logFilter.value.toLowerCase()),
  ),
);
const refPicker = ref<HTMLElement>();
const controllers = new Map<string, AbortController>();
let disposed = false;
let revisionGeneration = 0;
let resizeObserver: ResizeObserver | undefined;
let tabsObserver: ResizeObserver | undefined;
const projectPath = `/projects/${props.project.id}`;
const shortRef = computed(() =>
  selectedRef.value.replace(/^refs\/(heads|tags)\//, ""),
);
const currentRefLabel = computed(() =>
  /^[a-f0-9]{40}$/.test(shortRef.value)
    ? shortRef.value.slice(0, 8)
    : shortRef.value || "Revision",
);
const currentRefs = computed(() => refLists[refKind.value]);
const canRun = computed(
  () =>
    !revisionLoading.value &&
    !accessBlocked.value &&
    !!tree.value && visibleFiles.value.some((file) => file.path === previewPath.value),
);
let automaticPreview = "";
watch(
  [() => props.user?.id, canRun, () => props.project.entrypoint],
  () => {
    if (!props.user || !canRun.value || notebookPath.value) return;
    const selection = `${props.user.id}:${revisionGeneration}:${props.project.entrypoint}`;
    if (automaticPreview === selection) return;
    automaticPreview = selection;
    void run();
  },
  { flush: "post" },
);
function schedulePreview() {
  clearTimeout(previewTimer);
  if (!livePreview.value || committing.value || marimoEditing.value || netlogoPreparing.value) return;
  cancelPending();
  if (!props.user || !canRun.value) return;
  previewTimer = setTimeout(() => { if (!disposed) void run(); }, 700);
}
watch(draftChanges, (changes, previous) => {
  if (draftReady.value && branch.value && !committing.value && !libraryBusy.value) {
    rememberDraft();
    clearTimeout(autosaveTimer);
    if (JSON.stringify(changes) !== acknowledged) {
      draftStatus.value = "Saving draft…";
      autosaveTimer = setTimeout(() => { void flushDraft(); }, 600);
    }
  }
  if (!marimoEditing.value && !netlogoAuthoring.value && (changes.length || previous.length)) schedulePreview();
});
watch(livePreview, (enabled) => {
  if (enabled) schedulePreview();
  else { clearTimeout(previewTimer); cancelPending(); }
});
watch(committing, (value) => {
  if (value) { clearTimeout(previewTimer); cancelPending(); }
  else { if (draftReady.value) { rememberDraft(); void flushDraft(); } if (!marimoEditing.value && !netlogoAuthoring.value && (draftChanges.value.length || launch.value?.draft)) schedulePreview(); }
});
function stopLivePreview() {
  livePreview.value = false;
  clearTimeout(previewTimer);
  void stop();
}
onUnmounted(() => { clearTimeout(previewTimer); clearTimeout(netlogoTimer); });
function begin(key: string) {
  controllers.get(key)?.abort();
  const controller = new AbortController();
  controllers.set(key, controller);
  return controller.signal;
}
function current(key: string, signal: AbortSignal) {
  return (
    !disposed && !signal.aborted && controllers.get(key)?.signal === signal
  );
}
function cancel(...keys: string[]) {
  for (const key of keys) controllers.get(key)?.abort();
}
async function loadRefs(kind: RefKind, page = 1) {
  const key = `refs-${kind}`,
    signal = begin(key);
  refLoading[kind] = true;
  refErrors[kind] = "";
  try {
    const result = await api<RefList>(
      `${projectPath}/refs?kind=${kind}&page=${page}&limit=25`,
      { signal },
    );
    if (!current(key, signal)) return;
    refLists[kind] = {
      ...result,
      refs:
        page === 1
          ? result.refs
          : [...(refLists[kind]?.refs ?? []), ...result.refs],
    };
    return result;
  } catch (cause) {
    if (current(key, signal)) refErrors[kind] = (cause as Error).message;
  } finally {
    if (current(key, signal)) refLoading[kind] = false;
  }
}
async function initialize() {
  const generation = revisionGeneration;
  revisionLoading.value = true;
  const refs = await loadRefs("branch");
  if (disposed || generation !== revisionGeneration) return;
  if (!props.initialRef && !refs) {
    revisionError.value = refErrors.branch;
    revisionLoading.value = false;
    return;
  }
  if (!workingRef.value && refs) workingRef.value = `refs/heads/${refs.defaultBranch}`;
  if (workingRef.value) {
    try {
      draftReady.value = false;
    const latest = await api<SourceTree>(`${projectPath}/tree?ref=${encodeURIComponent(workingRef.value)}`);
      if (disposed || generation !== revisionGeneration) return;
      workingHead.value = latest.commit;
    } catch { /* Viewing an exact version remains possible without its branch. */ }
  }
  await loadRevision(props.initialBranch || props.initialRef || `refs/heads/${refs!.defaultBranch}`, false);
}
async function loadRevision(value: string, changes = false, context = "", reload = false) {
  if (!reload && !(await confirmLeave())) return;
  marimoEditing.value = false;
  draftReady.value = false;
  buffers.files.clear();
  commitMessage.value = "";
  commitError.value = "";
  conflict.value = undefined;
  inspectedHead.value = undefined;
  metadataEditing.value = false;
  branch.value = value.startsWith("refs/heads/") ? value : context.startsWith("refs/heads/") ? context : "";
  const refValue = value.trim();
  if (!refValue) return;
  revisionGeneration++;
  clearTimeout(previewTimer);
  const signal = begin("revision");
  cancel("source", "history", "diff");
  const previousPath = selected.value;
  void stop();
  showRefs.value = false;
  revisionLoading.value = true;
  revisionError.value = "";
  selectedRef.value = refValue;
  tree.value = null;

  selected.value = "";
  sourceState.value = "loading";
  sourceError.value = "";
  histories.value = null;
  historyLoading.value = false;
  historyError.value = "";
  launchError.value = "";
  diff.value = null;
  diffLoading.value = false;
  diffError.value = "";
  contentView.value = changes ? "diff" : "source";
  try {
    const result = await api<SourceTree>(
      `${projectPath}/tree?ref=${encodeURIComponent(refValue)}`,
      { signal },
    );
    if (!current("revision", signal)) return;
    tree.value = result;
    if (branch.value) { workingRef.value = branch.value; workingHead.value = result.commit; }
    if (branch.value && props.user && ["write", "admin"].includes(props.project.permission)) {
      let saved = await api<{ draft: Draft | null }>(`${projectPath}/draft`);
      if (!current("revision", signal)) return;
      if (saved.draft && !saved.draft.changes.length && !saved.draft.savingCommit && (saved.draft.ref !== branch.value || saved.draft.baseCommit !== result.commit)) {
        saved = await api<{ draft: Draft }>(`${projectPath}/draft`, { method: "PUT", body: JSON.stringify({ expectedVersion: saved.draft.version, ref: branch.value, baseCommit: result.commit, changes: [] }) });
      }
      if (!current("revision", signal)) return;
      if (saved.draft && saved.draft.ref !== branch.value) {
        // Inspect another branch without moving an existing working draft onto it.
        workingRef.value = saved.draft.ref;
        workingHead.value = "";
        branch.value = "";
      } else await hydrateDraft(saved.draft, () => current("revision", signal));
      if (!current("revision", signal)) return;
      if (!reload) {
        try { recovery.value = localStorage.getItem(`${recoveryKey.value}:recovery`) ?? recovery.value; const local = localStorage.getItem(recoveryKey.value); if (local && JSON.stringify(JSON.parse(local).changes) !== acknowledged) recovery.value = local; } catch {}
      }
    }
    writeUrl();
    openFiles.value = openFiles.value.filter((path) =>
      visibleFiles.value.some((file) => file.path === path),
    );
    const path = [
      previousPath,
      props.project.kind === "library" ? "README.md" : "",
      props.project.entrypoint,
      result.files[0]?.path,
    ].find(
      (candidate) =>
        candidate && visibleFiles.value.some((file) => file.path === candidate),
    );
    selected.value = path ?? "";
    if (changes) void loadDiff();
    else if (path) void selectFile(path);
    else sourceState.value = "ready";
    if (sidebar.value === "history") void loadHistory();
  } catch (cause) {
    if (current("revision", signal))
      revisionError.value = (cause as Error).message;
  } finally {
    if (current("revision", signal)) revisionLoading.value = false;
  }
}
async function selectFile(path: string) {
  if (!tree.value) return;
  const commit = tree.value.commit,
    signal = begin("source");
  cancel("diff");
  contentView.value = "source";
  selected.value = path;

  sourceState.value = "loading";
  sourceError.value = "";
  cursor.value = { line: 1, column: 1 };
  if (!openFiles.value.includes(path)) openFiles.value.push(path);
  if (buffers.files.has(path) && buffers.files.get(path)!.content !== null) { sourceState.value = "ready"; return; }
  try {
    const result = await api<{ commit: string; path: string; content: string }>(
      `${projectPath}/file?commit=${commit}&path=${encodeURIComponent(path)}`,
      { signal },
    );
    if (!current("source", signal) || tree.value?.commit !== commit) return;
    buffers.load(path, result.content);
    sourceState.value = "ready";
  } catch (cause) {
    if (current("source", signal)) {
      sourceError.value = (cause as Error).message;
      sourceState.value = "error";
    }
  }
}
async function closeFile(path: string) {
  if (committing.value || !(await finishMarimo()) || !(await finishNetlogo())) return;
  const index = openFiles.value.indexOf(path);
  openFiles.value = openFiles.value.filter((item) => item !== path);
  if (selected.value === path && contentView.value === "source") {
    const next = openFiles.value[Math.min(index, openFiles.value.length - 1)];
    if (next) void selectFile(next);
    else {
      cancel("source");
      selected.value = "";

      sourceState.value = "ready";
    }
  }
  if (!openFiles.value.length && previewPath.value) await hideSource();
}
async function loadHistory(page = 1) {
  if (!tree.value) return;
  const commit = tree.value.commit,
    signal = begin("history");
  historyLoading.value = true;
  historyError.value = "";
  try {
    const result = await api<CommitHistory>(
      `${projectPath}/history?commit=${commit}&page=${page}&limit=25`,
      { signal },
    );
    if (!current("history", signal)) return;
    histories.value = {
      ...result,
      commits:
        page === 1
          ? result.commits
          : [...(histories.value?.commits ?? []), ...result.commits],
    };
  } catch (cause) {
    if (current("history", signal))
      historyError.value = (cause as Error).message;
  } finally {
    if (current("history", signal)) historyLoading.value = false;
  }
}
async function loadDiff() {
  if (!tree.value) return;
  const commit = tree.value.commit,
    signal = begin("diff");
  cancel("source");
  sourceOpen.value = true;
  contentView.value = "diff";
  diffLoading.value = true;
  diffError.value = "";
  diff.value = null;
  try {
    const result = await api<CommitDiff>(
      `${projectPath}/diff?commit=${commit}`,
      { signal },
    );
    if (current("diff", signal) && tree.value?.commit === commit)
      diff.value = result;
  } catch (cause) {
    if (current("diff", signal)) diffError.value = (cause as Error).message;
  } finally {
    if (current("diff", signal)) diffLoading.value = false;
  }
}
async function closeSidebar() {
  const view = sidebar.value;
  sidebar.value = "";
  await nextTick();
  workspaceViews.value?.querySelector<HTMLButtonElement>(`[data-view="${view}"]`)?.focus();
}
async function switchSidebar(view: "files" | "history" | "about") {
  if (sidebar.value === view) { await closeSidebar(); return; }
  sidebar.value = view;
  if (view === "history" && !histories.value && !historyLoading.value) void loadHistory();
  await nextTick();
  if (narrow.value) sidebarPanel.value?.querySelector<HTMLButtonElement>(".sidebar-close")?.focus();
}
async function openSidebarFile(path: string) {
  sourceViewChosen = true;
  sourceOpen.value = true;
  await selectFile(path);
  writeUrl();
  if (narrow.value) sidebar.value = "";
  focusSelectedSource = true;
  await nextTick();
  focusOpenedSource();
}
async function viewVersion(commit: string, compare = false) {
  await loadRevision(commit, compare);
  if (narrow.value) await closeSidebar();
}
async function hideSource() {
  if (!(await finishMarimo()) || !(await finishNetlogo())) return;
  sourceViewChosen = true;
  sourceOpen.value = false;
  writeUrl();
  await nextTick();
  workspaceViews.value?.querySelector<HTMLButtonElement>('[data-view="files"]')?.focus();
}
async function restoreVersion() {
  if (!tree.value || !workingHead.value || !workingRef.value || restoring.value || buffers.dirty.value) return;
  restoring.value = true; restoreError.value = "";
  try {
    const result = await api<CommitResponse>(`${projectPath}/restores`, { method: "POST", body: JSON.stringify({ ref: workingRef.value, expectedCommit: workingHead.value, sourceCommit: tree.value.commit }) });
    restoreDialog.value?.close();
    restoring.value = false;
    await loadRevision(result.commit, false, result.ref);
  } catch (cause) { restoreError.value = (cause as Error).message; }
  finally { restoring.value = false; }
}
function showRefKind(kind: RefKind) {
  refKind.value = kind;
  if (!refLists[kind] && !refLoading[kind]) void loadRefs(kind);
}
async function closeRefPicker() {
  showRefs.value = false;
  await nextTick();
  refPicker.value
    ?.querySelector<HTMLButtonElement>(".revision-button")
    ?.focus();
}
async function tabKey(event: KeyboardEvent, path: string) {
  const index = openFiles.value.indexOf(path);
  let next: string | undefined;
  if (event.key === "ArrowRight")
    next = openFiles.value[(index + 1) % openFiles.value.length];
  else if (event.key === "ArrowLeft")
    next =
      openFiles.value[
        (index - 1 + openFiles.value.length) % openFiles.value.length
      ];
  else if (event.key === "Home") next = openFiles.value[0];
  else if (event.key === "End") next = openFiles.value.at(-1);
  else return;
  event.preventDefault();
  if (next) void selectFile(next);
  await nextTick();
  fileTabs.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
}
async function revealSelectedTab() {
  await nextTick();
  const tab = fileTabs.value?.querySelector('[aria-selected="true"]');
  (tab?.closest(".file-tab") ?? tab)?.scrollIntoView({
    block: "nearest",
    inline: "nearest",
  });
}
watch([selected, contentView], revealSelectedTab);
watch(showRefs, async (open) => {
  if (open) {
    if (!refLoading[refKind.value]) void loadRefs(refKind.value);
    await nextTick();
    refPicker.value?.querySelector<HTMLInputElement>("input")?.focus();
  }
});
function chooseRef(value: string) {
  revisionInput.value = "";
  void loadRevision(value);
  void closeRefPicker();
}
function outside(event: PointerEvent) {
  if (!refPicker.value?.contains(event.target as Node)) showRefs.value = false;
}
watch(owner, () => { void refreshAccess(); });
watch([() => props.user?.id, () => props.project.permission], ([userId, permission]) => {
  if (!userId) void stop();
  else {
    void refreshAccess();
    if (["write", "admin"].includes(permission)) {
      if (!sourceViewChosen) sourceOpen.value = true;
      if (!draftReady.value) void initialize();
    }
  }
});
onMounted(() => {
  narrowQuery.addEventListener("change", updateNarrow);
  const origin = props.project.forkedFrom ?? props.project.extractedFrom;
  if (origin) void api<{ project: Project }>(`/projects/${origin.projectId}`).then(result => { if (!disposed) ancestor.value = result.project; }).catch(() => {});
  void initialize();
  void refreshAccess();
  resizeObserver = new ResizeObserver(([entry]) => {
    if (!entry) return;
    panesWidth.value = entry.contentRect.width;
    paneHeight.value = entry.contentRect.height;
    consoleHeight.value = Math.min(
      consoleHeight.value,
      Math.max(80, paneHeight.value - 140),
    );
  });
  if (workPanes.value) resizeObserver.observe(workPanes.value);
  tabsObserver = new ResizeObserver(() => {
    void revealSelectedTab();
  });
  if (fileTabs.value) tabsObserver.observe(fileTabs.value);
  window.addEventListener("pointerdown", outside);
  window.addEventListener("beforeunload", beforeUnload);
});
onUnmounted(() => {
  narrowQuery.removeEventListener("change", updateNarrow);
  clearTimeout(autosaveTimer);
  rememberDraft();
  disposed = true;
  accessRequest++;
  for (const controller of controllers.values()) controller.abort();
  resizeObserver?.disconnect();
  tabsObserver?.disconnect();
  window.removeEventListener("pointerdown", outside);
  window.removeEventListener("beforeunload", beforeUnload);
  void stop();
});
defineExpose({ stop, confirmLeave, refreshAccess });
</script>

<template>
  <div class="workspace-root">
    <div class="workspace-toolbar">
      <div
        v-show="sourceOpen"
        ref="refPicker"
        class="revision-control"
        @keydown.esc="closeRefPicker"
      >
        <button
          class="revision-button"
          :aria-label="demoMode ? 'Version details' : 'Git details'"
          :aria-expanded="showRefs"
          @click="showRefs = !showRefs"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M4 4v7m8-7v1a3 3 0 0 1-3 3H7M6 3a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm0 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm8-10a2 2 0 1 1-4 0 2 2 0 0 1 4 0z"
            /></svg
          >{{ demoMode ? "Version details" : "Git details" }}<span>⌄</span>
        </button>
        <div v-show="showRefs" class="revision-menu">
          <p class="git-current">{{ branch || currentRefLabel }}<br /><code v-if="tree" aria-label="Selected commit" :title="tree.commit">{{ tree.commit.slice(0, 12) }}</code></p>
          <form
            class="revision-form"
            @submit.prevent="chooseRef(revisionInput)"
          >
            <input
              v-model="revisionInput"
              aria-label="Revision"
              placeholder="Branch, tag or commit"
            /><button
              class="quiet"
              type="submit"
              :disabled="!revisionInput.trim()"
            >
              Go
            </button>
          </form>
          <div class="revision-kinds">
            <button
              :class="{ active: refKind === 'branch' }"
              @click="showRefKind('branch')"
            >
              Branches</button
            ><button
              :class="{ active: refKind === 'tag' }"
              @click="showRefKind('tag')"
            >
              Tags
            </button>
          </div>
          <div class="revision-options">
            <button
              v-for="item in currentRefs?.refs"
              :key="item.ref"
              class="revision-option"
              @click="chooseRef(item.ref)"
            >
              <span>{{ item.name }}</span
              ><code>{{ item.commit.slice(0, 8) }}</code>
            </button>
            <p
              v-if="
                !refLoading[refKind] &&
                !refErrors[refKind] &&
                !currentRefs?.refs.length
              "
              class="empty"
            >
              No {{ refKind === "branch" ? "branches" : "tags" }}.
            </p>
          </div>
          <div v-if="refErrors[refKind]" class="pane-error" role="alert">
            {{ refErrors[refKind] }}
            <button @click="loadRefs(refKind)">Retry</button>
          </div>
          <div v-if="refLoading[refKind]" class="empty" role="status">
            Loading…
          </div>
          <button
            v-else-if="currentRefs?.nextPage"
            class="load-more"
            @click="loadRefs(refKind, currentRefs!.nextPage!)"
          >
            Load more
          </button>
        </div>
      </div>
      <button
        class="icon-button"
        aria-label="Refresh latest version"
        title="Refresh latest version"
        :disabled="revisionLoading || committing"
        @click="branch ? loadRevision(branch) : selectedRef ? loadRevision(selectedRef) : initialize()"
      >
        ↻
      </button>
      <span v-if="revisionLoading" class="toolbar-status" role="status"
        >Loading…</span
      >
      <nav ref="workspaceViews" class="workspace-views" aria-label="Workspace views">
        <button class="quiet" data-view="files" :class="{ active: sidebar === 'files' }" :aria-expanded="sidebar === 'files'" aria-controls="project-sidebar" @click="switchSidebar('files')">Files</button>
        <button class="quiet" data-view="history" :class="{ active: sidebar === 'history' }" :aria-expanded="sidebar === 'history'" aria-controls="project-sidebar" @click="switchSidebar('history')">History</button>
        <button class="quiet" data-view="about" :class="{ active: sidebar === 'about' }" :aria-expanded="sidebar === 'about'" aria-controls="project-sidebar" :aria-label="`About ${project.kind === 'library' ? 'library' : 'artifact'}`" @click="switchSidebar('about')">About</button>
      </nav>
      <span v-if="tree && !branch" class="version-context">Earlier version <button class="quiet" :disabled="restoring" @click="loadRevision(workingRef)">Back to draft</button><button v-if="user && ['write', 'admin'].includes(project.permission)" class="quiet" :disabled="!workingHead || accessBlocked || restoring" @click="restoreError = ''; restoreDialog?.showModal()">Restore this version</button></span>
      <span v-if="ancestor" class="ancestry-link">{{ project.forkedFrom ? "Based on" : "Extracted from" }} <a :href="`#/project/${ancestor.id}`">{{ ancestor.title }} ↗</a></span>
      <div class="workspace-actions">
        <LibraryUsage v-if="project.kind === 'library'" :project="project" :signed-in="!!user" @sign-in="emit('sign-in', $event)" />
        <button class="quiet" :disabled="!tree || committing || buffers.dirty.value || marimoEditing || netlogoAuthoring || netlogoPreparing" :title="buffers.dirty.value ? 'Save a version before forking' : undefined" @click="user ? showFork = true : emit('sign-in', () => showFork = true)">Fork</button>
        <button v-if="sourceOpen" class="quiet" :disabled="!tree || revisionLoading || committing || libraryBusy || buffers.dirty.value || marimoEditing || netlogoAuthoring || netlogoPreparing" :title="buffers.dirty.value ? 'Save a version before extracting' : undefined" @click="user ? showExtraction = true : emit('sign-in', () => showExtraction = true)">Extract library</button>
        <button
          class="quiet"
          v-if="sourceOpen"
          :class="{ active: consoleOpen }"
          :aria-pressed="consoleOpen"
          @click="consoleOpen = !consoleOpen"
        >
          Console</button
        ><button v-if="launch" class="quiet" @click="stopLivePreview">Stop</button
        ><button
          v-if="previewPath"
          class="launch-button"
          :title="draftChanges.length ? 'Reload preview with draft changes' : tree ? 'Reload saved version' : undefined"
          :disabled="launching || stopping || !canRun"
          @click="run"
        >
          {{ launching ? "Starting…" : launch ? "Reload" : "Run" }}
        </button>
      </div>
    </div>
    <div v-if="revisionError" class="error-banner" role="alert">
      {{ revisionError }}
      <button @click="branch ? loadRevision(branch) : selectedRef ? loadRevision(selectedRef) : initialize()">
        Retry
      </button>
    </div>
    <div v-if="accessError" role="alert" class="error-banner">{{ accessError }}<button @click="refreshAccess">Retry access status</button></div>
    <div v-if="accessStatus?.effective.mode === 'owner_read_only'" role="status" class="error-banner">Access change pending · Owner read-only <button @click="refreshAccess">Refresh access status</button></div>
    <div v-if="editable && sourceOpen" class="commit-toolbar" :inert="netlogoAuthoring || netlogoPreparing || undefined">
      <span :title="buffers.dirty.value ? 'Draft changes are autosaved. Save a version to add them to history.' : undefined">{{ marimoSaving ? "Saving notebook…" : buffers.dirty.value ? `${buffers.changed.value.length} draft changes` : "Version saved" }}</span>
      <input v-model="commitMessage" aria-label="What changed?" placeholder="What changed? (optional)" maxlength="2000" />
      <button class="quiet" :disabled="committing || marimoSaving || (!marimoEditing && !buffers.dirty.value && !pendingSave)" @click="commitChanges()">{{ committing || marimoSaving ? "Saving…" : "Save version" }}</button>
      <button v-if="project.entrypoint" class="quiet" :disabled="committing || marimoSaving || (!marimoEditing && !buffers.dirty.value)" @click="commitChanges(true)">Save version and run</button>
    </div>
    <div v-if="draftError || recovery" class="error-banner" role="alert">
      <span>{{ draftError || "A browser recovery copy is available." }}</span>
      <button @click="downloadRecovery">Download recovery</button>
      <button :disabled="committing || restoring || libraryBusy || revisionLoading" @click="reloadServerDraft">Reload saved draft</button>
      <button v-if="!draftConflict && draftError" @click="flushDraft">Retry</button>
      <button v-if="recovery" @click="recovery = null">Dismiss</button>
    </div>
    <div v-if="commitError" class="error-banner" role="alert">
      <span>{{ commitError }}<template v-if="conflict !== undefined"> · Latest version: {{ conflict ? conflict.slice(0, 12) : "deleted" }}</template></span>
      <button :disabled="inspecting" @click="inspectBranch">Check latest version</button>
      <code v-if="inspectedHead">{{ inspectedHead }}</code>
      <button v-if="conflict !== undefined" @click="downloadRecovery">Download draft</button>
      <button v-if="inspectedHead" :disabled="committing" @click="discardDraftForLatest">Discard draft and use latest</button>
    </div>
    <main
      class="workspace"
      :style="{
        '--sidebar-width': `${sidebarWidth}px`,
        '--code-width': previewPath ? `${codeWidth}%` : '100%',
        '--console-height': `${consoleHeight}px`,
      }"
    >
      <aside v-if="sidebar" id="project-sidebar" ref="sidebarPanel" class="sidebar" aria-label="Project sidebar" @keydown.esc.stop.prevent="closeSidebar" :inert="netlogoAuthoring || netlogoPreparing || undefined">
        <div class="pane-heading">
          {{
            sidebar === "files"
              ? "Files"
              : sidebar === "history"
                ? "History"
                : "About"
          }}
          <button class="icon-button sidebar-close" aria-label="Close sidebar" @click="closeSidebar">×</button>
        </div>
        <div class="sidebar-scroll">
          <template v-if="sidebar === 'files'">
            <form v-if="editable" class="new-file-form" @submit.prevent="createFile"><input v-model="newPath" aria-label="New file path" placeholder="New file path" :disabled="committing"/><button class="quiet" :disabled="committing || !newPath">Create</button></form>
            <p v-if="fileError" class="pane-error" role="alert">{{ fileError }}</p>
            <div v-if="buffers.dirty.value" class="draft-changes" aria-label="Unsaved files">
              <div v-for="[path, file] in buffers.changed.value" :key="path"><button :disabled="file.content === null" @click="openSidebarFile(path)"><span>{{ file.content === null ? 'D' : file.original === null ? 'A' : 'M' }}</span> {{ path }}</button><button :aria-label="`Discard ${path}`" :disabled="committing" @click="discardFile(path)">↶</button></div>
            </div>
            <FileTree
              v-if="visibleFiles.length && !revisionLoading"
              :files="visibleFiles"
              :selected="selected"
              @select="openSidebarFile"
            />
            <p v-else class="empty">
              {{
                revisionLoading
                  ? "Loading…"
                  : tree
                    ? "No files."
                    : "No revision loaded."
              }}
            </p>
          <ProjectLibraries v-if="tree" :initial-library-id="requestedLibrary" @requested="requestedLibrary = ''" :project="project" :commit="tree.commit" :branch="branch" :editable="!!user && ['write', 'admin'].includes(project.permission) && branch.startsWith('refs/heads/') && draftReady && !revisionLoading && !accessBlocked && !committing && !metadataEditing && !metadataBusy && !marimoEditing" :dirty="false" :draft-version="draft?.version ?? 0" :use-draft="draftReady" :flush-draft="flushDraft" @busy="libraryBusy = $event || libraryHydrating" @drafted="libraryDrafted" />
          </template>
          <template v-else-if="sidebar === 'history'">
            <div
              v-for="item in histories?.commits"
              :key="item.commit"
              class="history-entry"
              :data-commit="item.commit"
              :class="{ selected: item.commit === tree?.commit }"
            >
              <button
                class="history-select"
                :title="item.message"
                @click="viewVersion(item.commit)"
              >
                <strong>{{ item.message.split("\n")[0] }}</strong
                ><span
                  >{{ item.author.name }} ·
                  {{ new Date(item.author.date).toLocaleDateString() }}</span
                >
              </button>
              <div class="history-meta">
                <span>{{ item.commit === workingHead ? "Latest" : item.commit === tree?.commit ? "Viewing" : "" }}</span
                ><button
                  :aria-label="`Compare ${item.message.split('\n')[0]}`"
                  @click="viewVersion(item.commit, true)"
                >
                  Compare
                </button>
              </div>
            </div>
            <div v-if="historyError" class="pane-error" role="alert">
              {{ historyError }} <button @click="loadHistory()">Retry</button>
            </div>
            <p v-if="historyLoading" class="empty" role="status">Loading…</p>
            <button
              v-else-if="histories?.nextPage"
              class="load-more"
              @click="loadHistory(histories!.nextPage!)"
            >
              Load more
            </button>
            <p
              v-else-if="!histories?.commits.length && !historyError"
              class="empty"
            >
              {{ revisionLoading ? "Loading…" : "No history loaded." }}
            </p>
          </template>
          <div v-else class="about">
            <form v-if="metadataEditing" class="metadata-form" @submit.prevent="saveMetadata">
              <label>Title<input v-model="metadata.title" required maxlength="120" :disabled="metadataBusy || accessBlocked" /></label>
              <label>Description<textarea v-model="metadata.description" maxlength="4000" :disabled="metadataBusy || accessBlocked" /></label>
              <label>License<input v-model="metadata.license" required maxlength="100" :disabled="metadataBusy || accessBlocked" /></label>
              <label>Entrypoint<input v-model="metadata.entrypoint" :required="project.kind !== 'library'" maxlength="500" :disabled="metadataBusy || accessBlocked" /></label>
              <label>Data origins<textarea v-model="metadataOrigins" rows="3" :disabled="metadataBusy || accessBlocked" placeholder="https://data.example.org" /></label>
              <p class="field-note">One HTTP(S) origin per line. The data server must allow the null origin.</p>
              <p v-if="metadataError" role="alert" class="pane-error">{{ metadataError }}</p>
              <button class="quiet" :disabled="metadataBusy || accessBlocked">Save metadata</button>
              <button class="quiet" type="button" :disabled="metadataBusy || accessBlocked" @click="metadataEditing = false">Cancel</button>
            </form>
            <button v-else-if="project.permission === 'admin'" class="quiet" :disabled="revisionLoading || committing || marimoEditing || accessBlocked" @click="editMetadata">Edit metadata</button>
            <ProjectAccess v-if="owner && !demoMode" :project="project" :status="accessStatus" @status="accessStatus = $event" @updated="emit('updated', $event)" />
            <h2>{{ project.title }}</h2>
            <p>{{ project.description }}</p>
            <dl>
              <template v-if="project.forkedFrom || project.extractedFrom"><dt>{{ project.forkedFrom ? "Based on" : "Extracted from" }}</dt><dd><a v-if="ancestor" :href="`#/project/${ancestor.id}?ref=${(project.forkedFrom ?? project.extractedFrom)!.commit}`">{{ ancestor.title }} ↗</a><span v-else>Unavailable project</span></dd></template>
              <dt>Kind</dt><dd>{{ project.kind === "library" ? "Library" : "Artifact" }}</dd>
              <dt>Access</dt>
              <dd>{{ owner ? (accessBlocked ? "Owner · Read-only" : "Owner") : project.permission === "write" ? "Write" : "Read" }}</dd>
              <dt>Author</dt>
              <dd>{{ project.ownerName }}</dd>
              <dt>License</dt>
              <dd>{{ project.license }}</dd>
              <dt>Entrypoint</dt>
              <dd>{{ project.entrypoint || "None" }}</dd>
              <dt>Data origins</dt>
              <dd>{{ project.dataOrigins.length ? project.dataOrigins.join(', ') : 'None' }}</dd>

              <dt>Visibility</dt>
              <dd>{{ demoMode ? (owner ? "This browser only" : "Bundled example") : project.visibility }}</dd>
            </dl>
            <button
              v-if="tree?.files.some((file) => file.path === 'README.md')"
              class="text-action"
              @click="
                sidebar = 'files';
                sourceOpen = true;
                openSidebarFile('README.md');
              "
            >
              Open README.md
            </button>
          </div>
        </div>
      </aside>
      <PaneDivider
        v-if="sidebar"
        v-model:value="sidebarWidth"
        label="Resize sidebar"
        :min="160"
        :max="380"
      />
      <section ref="workPanes" class="work-panes" :inert="narrow && !!sidebar || undefined">
        <section v-show="sourceOpen" class="code-console" :inert="netlogoAuthoring || netlogoPreparing || undefined">
          <div class="code-pane">
            <div class="editor-toolbar">
              <div
                ref="fileTabs"
                class="file-tabs"
                role="tablist"
                aria-label="Open files"
              >
                <div
                  v-for="path in openFiles"
                  :key="path"
                  class="file-tab"
                  :class="{
                    active: contentView === 'source' && selected === path,
                  }"
                >
                  <button
                    role="tab"
                    :aria-selected="
                      contentView === 'source' && selected === path
                    "
                    :title="path"
                    :tabindex="
                      contentView === 'source' && selected === path ? 0 : -1
                    "
                    @keydown="tabKey($event, path)"
                    @keydown.delete.prevent="closeFile(path)"
                    @click="selectFile(path)"
                  >
                    {{ path.split("/").at(-1) }}{{ buffers.files.get(path)?.original !== buffers.files.get(path)?.content ? " ●" : "" }}</button
                  ><button
                    class="tab-close"
                    tabindex="-1"
                    :aria-label="`Close ${path}`"
                    @click="closeFile(path)"
                  >
                    ×
                  </button>
                </div>
                <button
                  v-if="contentView === 'diff'"
                  class="diff-tab"
                  role="tab"
                  aria-selected="true"
                >
                  Compare
                </button>
              </div>
              <div class="editor-actions">
                <button v-if="/\.py$/i.test(selected) && /(?:import marimo|from marimo)/.test(source) && !marimoEditing" class="quiet" @click="notebookPath = selected; openNotebook(false)">Open notebook</button>
                <button v-if="editable && selected" class="quiet" :disabled="committing || marimoEditing" @click="deleteFile">Delete file</button>
                <button
                  v-if="
                    selected &&
                    contentView === 'source' &&
                    sourceState === 'ready'
                  "
                  class="icon-button"
                  aria-label="Find in file"
                  title="Find in file"
                  @click="sourceEditor?.find()"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="6.5" cy="6.5" r="4.5" />
                    <path d="m10 10 4 4" />
                  </svg></button
                ><button
                  class="quiet"
                  :disabled="!tree || revisionLoading"
                  @click="loadDiff"
                >
                  Compare
                </button>
                <button v-if="previewPath" class="icon-button" aria-label="Close code view" title="Close code view" @click="hideSource">×</button>
              </div>
            </div>
            <div v-if="revisionLoading" class="empty" role="status">
              Loading revision…
            </div>
            <template v-else-if="contentView === 'diff'"
              ><div v-if="diffLoading" class="empty" role="status">
                Loading diff…
              </div>
              <div v-else-if="diffError" class="pane-error" role="alert">
                {{ diffError }} <button @click="loadDiff">Retry</button>
              </div>
              <DiffView
                v-else-if="diff"
                :patch="diff.patch"
                :commit="diff.commit"
                :base="diff.base"
            /></template>
            <template v-else
              ><div v-if="!selected" class="empty">
                {{ tree?.files.length ? "Select a file." : "" }}
              </div>
              <div
                v-else-if="sourceState === 'loading'"
                class="empty"
                role="status"
              >
                Loading file…
              </div>
              <div
                v-else-if="sourceState === 'error'"
                class="pane-error"
                role="alert"
              >
                {{ sourceError }}
                <button @click="selectFile(selected)">Retry</button>
              </div>
              <template v-else
                ><div v-if="source.length === 0" class="empty-file">
                  Empty file
                </div>
                <component
                  :is="/\.nlogox?$/i.test(selected) ? NetLogoSourceEditor : SourceEditor"
                  ref="sourceEditor"
                  :content="source"
                  :editable="editable && !(marimoEditing && selected === previewPath)"
                  @update:content="updateSource"
                  :path="selected"
                  @cursor="
                    (line, column) => (cursor = { line, column })
                  " /></template
            ></template>
          </div>
          <PaneDivider
            v-if="consoleOpen"
            v-model:value="consoleHeight"
            label="Resize code and console"
            orientation="horizontal"
            :min="80"
            :max="Math.max(80, paneHeight - 140)"
            reverse
          />
          <section v-if="consoleOpen" class="console">
            <div class="pane-heading console-toolbar">
              <div role="tablist" aria-label="Output views">
                <button
                  role="tab"
                  :aria-selected="consoleTab === 'console'"
                  :class="{ active: consoleTab === 'console' }"
                  @click="consoleTab = 'console'"
                >
                  Console</button
                ><button
                  role="tab"
                  :aria-selected="consoleTab === 'activity'"
                  :class="{ active: consoleTab === 'activity' }"
                  @click="consoleTab = 'activity'"
                >
                  Activity
                </button>
              </div>
              <input
                v-if="consoleTab === 'console'"
                v-model="logFilter"
                aria-label="Filter console"
                placeholder="Filter"
              /><button
                class="quiet"
                @click="
                  consoleTab === 'console' ? (consoleLines = []) : (events = [])
                "
              >
                Clear
              </button>
            </div>
            <div
              v-if="consoleTab === 'console'"
              class="console-output"
              role="log"
              aria-label="Artifact console"
            >
              <div
                v-for="line in filteredConsole"
                :key="line.id"
                :class="`console-${line.level}`"
              >
                <time>{{ line.time }}</time
                ><span>{{ line.text }}</span>
              </div>
            </div>
            <div
              v-else
              class="console-output"
              role="log"
              aria-label="Host activity"
            >
              <div v-for="(event, index) in events" :key="index">
                <time>{{ event.time }}</time
                ><span>{{ event.text }}</span>
              </div>
            </div>
          </section>
        </section>
        <PaneDivider
          v-if="previewPath && sourceOpen"
          v-model:value="codeWidth"
          label="Resize source and preview"
          :min="25"
          :max="75"
          :step="3"
          :scale="100 / panesWidth"
          :collapse-below="12"
          @collapse="hideSource"
        />
        <section v-if="project.entrypoint || notebookPath" class="preview-pane">
          <div class="pane-heading preview-toolbar">
            <select v-if="visibleFiles.some(file => /\.py$/i.test(file.path))" v-model="notebookPath" :disabled="marimoEditing" aria-label="Preview file" @change="openNotebook(false)">
              <option value="">{{ project.entrypoint || 'Choose a notebook' }}</option>
              <option v-for="file in visibleFiles.filter(file => /\.py$/i.test(file.path) && file.path !== project.entrypoint)" :key="file.path" :value="file.path">{{ file.path }}</option>
            </select>
            <button v-if="/\.py$/i.test(previewPath) && editable" class="quiet" :disabled="marimoSaving || launching || committing || metadataEditing" @click="openNotebook(!marimoEditing)">{{ marimoEditing ? 'View notebook' : 'Edit notebook' }}</button>
            <span>Preview <span v-if="launch?.draft" class="preview-draft">· Draft</span></span>
            <select v-model="effectivePreviewSizing" aria-label="Preview size" class="preview-size" :disabled="netlogoAuthoring || /\.py$/i.test(previewPath)" title="Fit the simulation to this pane, or display it at its original size">
              <option value="fit">Fit</option>
              <option value="actual">Actual size</option>
            </select>
            <label v-if="sourceOpen && !netlogoAuthoring && !marimoEditing" class="live-preview"><input v-model="livePreview" type="checkbox" />Live preview</label>
            <template v-if="isNetlogo">
              <span v-if="netlogoAuthoring" role="status">{{ netlogoSaving || netlogoDirty ? 'Saving interface…' : 'Interface saved to draft' }}</span>
              <button v-if="netlogoAuthoring" class="quiet" :disabled="netlogoSaving" @click="run">Done</button>
              <button v-else-if="editable" class="quiet" :disabled="!netlogoReady || netlogoSaving || netlogoPreparing" @click="editNetlogoInterface">{{ netlogoPreparing ? 'Loading interface…' : 'Edit interface' }}</button>
              <a v-if="launch?.standaloneUrl" class="quiet" :href="launch.standaloneUrl" target="_blank" rel="noopener noreferrer" title="Open this snapshot separately. Export edits there to import them into Lab.">Open model ↗</a>
            </template>

          </div>
          <div v-if="launchError" class="pane-error" role="alert">
            {{ launchError }} <button @click="run">Retry</button>
          </div>
          <div v-if="notebookError" class="pane-error" role="alert">{{ notebookError }}</div>
          <div v-if="netlogoError" class="pane-error" role="alert">{{ netlogoError }} <button v-if="netlogoDirty" @click="captureNetlogo()">Retry save</button></div>
          <div v-if="netlogoNotice" class="pane-error" role="status">{{ netlogoNotice }}</div>
          <iframe
            v-if="launch"
            ref="iframe"
            :key="launch.id"
            :inert="committing || marimoSaving || undefined"
            :src="launch.url"
            title="Artifact preview"
            :sandbox="launch.runtime === 'marimo' ? (demoMode ? 'allow-scripts allow-downloads' : 'allow-scripts allow-same-origin allow-downloads') : launch.runtime === 'netlogo' ? (demoMode ? 'allow-scripts allow-downloads allow-modals allow-forms' : 'allow-scripts allow-same-origin allow-downloads allow-modals allow-forms') : 'allow-scripts'"
            referrerpolicy="no-referrer"
          ></iframe>
          <div v-else-if="!launchError" class="preview-empty">
            <span v-if="revisionLoading || launching" role="status">Loading preview…</span>
            <button v-else-if="!user && canRun" class="quiet" @click="emit('sign-in')">Sign in to preview</button>
            <span v-else-if="stopping" role="status">Stopping…</span>
          </div>
        </section>
      </section>
    </main>
    <dialog ref="netlogoConversion" class="login-dialog" aria-labelledby="netlogo-conversion-title" @cancel.prevent="!netlogoSaving && netlogoConversion?.close()">
      <h2 id="netlogo-conversion-title">Convert for interface editing</h2>
      <p>NetLogo Web saves visual edits as .nlogox. Save a version with your current draft and a converted copy; the original .nlogo file stays in the project.</p>
      <p v-if="!owner">The project owner can change its entrypoint. You can also fork this model and convert your copy.</p>
      <p v-else-if="!canConvertNetlogo">Switch to the default branch to convert. The entrypoint applies to the whole project.</p>
      <p v-if="netlogoError" role="alert" class="pane-error">{{ netlogoError }}</p>
      <button class="quiet" :disabled="netlogoSaving" @click="netlogoConversion?.close()">Cancel</button>
      <button class="launch-button" :disabled="!canConvertNetlogo || netlogoSaving" @click="convertNetlogo">{{ netlogoSaving ? 'Converting…' : 'Convert model' }}</button>
    </dialog>
    <dialog ref="restoreDialog" class="login-dialog" @cancel.prevent="!restoring && restoreDialog?.close()">
      <h2>Restore this version?</h2><p>This saves the earlier files as a new version. Your existing history stays available.</p>
      <p v-if="restoreError" role="alert" class="pane-error">{{ restoreError }}</p>
      <button class="quiet" :disabled="restoring" @click="restoreDialog?.close()">Cancel</button>
      <button class="launch-button" :disabled="restoring" @click="restoreVersion">{{ restoring ? 'Restoring…' : 'Restore version' }}</button>
    </dialog>
    <DiscardDialog ref="discardDialog" />
    <ProjectDialog :open="showExtraction" :extraction="tree ? { project, commit: tree.commit, files: tree.files } : undefined" @close="showExtraction = false" @created="emit('created', $event)" />
    <ProjectDialog :open="showFork" :source="tree ? { project, commit: tree.commit } : undefined" @close="showFork = false" @created="emit('created', $event)" />
    <footer class="statusbar">
      <span role="status" aria-label="Save status">{{
        tree ? (branch ? editable ? draftStatus : "Saved version" : "Earlier version") : "Loading source…"
      }}</span
      ><span v-if="sourceOpen && selected && contentView === 'source'"
        >{{ selected }} · Ln {{ cursor.line }}, Col {{ cursor.column }} ·
        UTF-8</span
      >
    </footer>
  </div>
</template>
