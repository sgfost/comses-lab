<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted, useId } from "vue";
import type {
  Project,
  ProjectTemplate,
  TemplateId,
  CreateProjectRequest,
  ForkProjectRequest,
  CreateProjectResponse,
} from "../../../shared/contracts";
import { api, demoMode } from "../api";
const props = defineProps<{
  open: boolean;
  kind?: "model" | "library";
  extraction?: { project: Project; commit: string; files: { path: string }[] };
  source?: { project: Project; commit: string };
}>();
const emit = defineEmits<{
  close: [];
  created: [result: CreateProjectResponse];
}>();
const dialog = ref<HTMLDialogElement>();
const titleId = useId();
const templates = ref<ProjectTemplate[]>([]);
const templateId = ref<TemplateId>("worker");
const title = ref("");
const paths = ref<string[]>([]);
const netlogoFile = ref<{ name: string; content: string }>();
const fileInput = ref<HTMLInputElement>();
const readingFile = ref(false);
const fileError = ref("");
let fileGeneration = 0;
let suggestedTitle = "";
function clearNetLogoFile() {
  fileGeneration++;
  netlogoFile.value = undefined;
  fileError.value = "";
  readingFile.value = false;
  if (fileInput.value) fileInput.value.value = "";
}
watch(templateId, clearNetLogoFile);
async function selectNetLogoFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  fileGeneration++;
  netlogoFile.value = undefined;
  fileError.value = "";
  readingFile.value = false;
  error.value = "";
  if (!file) return;
  if (!/\.nlogox?$/i.test(file.name)) {
    fileError.value = "Choose a .nlogo or .nlogox model.";
    return;
  }
  if (file.size > 2_000_000) {
    fileError.value = "The model file must be 2 MB or smaller.";
    return;
  }
  const generation = fileGeneration;
  readingFile.value = true;
  try {
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
    if (generation !== fileGeneration) return;
    if (!content.trim() || content.includes("\0")) throw new Error("Choose a nonempty UTF-8 NetLogo model.");
    netlogoFile.value = { name: file.name, content };
    if (!title.value.trim() || title.value === suggestedTitle) {
      suggestedTitle = file.name.replace(/\.nlogox?$/i, "").slice(0, 120);
      title.value = suggestedTitle;
    }
  } catch (cause) {
    if (generation === fileGeneration) fileError.value = cause instanceof TypeError
      ? "The model must be a UTF-8 text file."
      : (cause as Error).message;
  } finally {
    if (generation === fileGeneration) readingFile.value = false;
  }
}

const availableTemplates = computed(() => templates.value.filter(item => (item.kind ?? "model") === (props.kind ?? "model")));
const subject = computed(() => props.extraction || (props.source?.project.kind ?? props.kind) === "library" ? "library" : "artifact");
const description = ref("");
const visibility = ref<"public" | "private">("private");
const loading = ref(false);
const busy = ref(false);
const error = ref("");
let requestId = "";
let lastBody = "";
let controller: AbortController | undefined;
async function loadTemplates() {
  controller?.abort();
  const currentController = new AbortController();
  controller = currentController;
  loading.value = true;
  error.value = "";
  try {
    const result = (
      await api<{ templates: ProjectTemplate[] }>("/templates", {
        signal: currentController.signal,
      })
    ).templates;
    if (controller === currentController && !currentController.signal.aborted && props.open && !props.source && !props.extraction) templates.value = result;
  } catch (cause) {
    if (controller === currentController && !currentController.signal.aborted && props.open) error.value = (cause as Error).message;
  } finally {
    if (controller === currentController && !currentController.signal.aborted) loading.value = false;
  }
}
watch(
  () => props.open,
  async (open) => {
    await nextTick();
    controller?.abort();
    if (!open) {
      clearNetLogoFile();
      dialog.value?.close();
      return;
    }
    loading.value = false;
    paths.value = [];
    clearNetLogoFile();
    suggestedTitle = "";
    templateId.value = props.kind === "library" ? "library-python" : "worker";
    title.value = props.source ? `${props.source.project.title} fork` : "";
    description.value = "";
    visibility.value = "private";
    error.value = "";
    requestId = crypto.randomUUID();
    lastBody = "";
    dialog.value?.showModal();
    if (!props.source && !props.extraction) void loadTemplates();
  },
);
function close() {
  if (!busy.value) emit("close");
}
async function submit() {
  if (busy.value || readingFile.value || fileError.value) return;
  const fields = props.extraction
    ? { commit: props.extraction.commit, title: title.value.trim(), visibility: visibility.value, paths: paths.value }
    : props.source
    ? {
        commit: props.source.commit,
        title: title.value.trim(),
        visibility: visibility.value,
      }
    : {
        templateId: templateId.value,
        title: title.value.trim(),
        visibility: visibility.value,
        ...(description.value ? { description: description.value } : {}),
        ...(templateId.value === "netlogo" && netlogoFile.value ? { netlogoFile: netlogoFile.value } : {}),
      };
  const serialized = JSON.stringify(fields);
  if (lastBody && serialized !== lastBody) requestId = crypto.randomUUID();
  lastBody = serialized;
  const body = { requestId, ...fields } as
    | CreateProjectRequest
    | ForkProjectRequest;
  busy.value = true;
  error.value = "";
  try {
    const result = await api<CreateProjectResponse>(
      props.extraction ? `/projects/${props.extraction.project.id}/extractions` : props.source ? `/projects/${props.source.project.id}/forks` : "/projects",
      { method: "POST", body: JSON.stringify(body) },
    );
    emit("created", result);
    emit("close");
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
onUnmounted(() => controller?.abort());
</script>
<template>
  <dialog
    ref="dialog"
    class="login-dialog project-dialog"
    :aria-labelledby="titleId"
    @cancel.prevent="close"
    @click="$event.target === dialog && close()"
  >
    <form @submit.prevent="submit">
      <button
        type="button"
        class="close"
        aria-label="Close project dialog"
        :disabled="busy"
        @click="close"
      >
        ×
      </button>
      <h2 :id="titleId">
        {{ extraction ? "Extract library" : source ? `Fork ${subject}` : `New ${subject}` }}
      </h2>
      <p v-if="source" class="fork-revision">
        Based on {{ source.project.title }}
      </p>
      <label v-if="!source && !extraction"
        >Template<select
          v-model="templateId"
          aria-label="Template"
          :disabled="busy || loading"
          required
        >
          <option
            v-for="template in availableTemplates"
            :key="template.id"
            :value="template.id"
          >
            {{ template.title }}
          </option>
        </select></label
      >
      <p v-if="loading" role="status">Loading templates…</p>
      <template v-if="!source && !extraction && templateId === 'netlogo'">
        <label>Import model (optional)<input ref="fileInput" type="file" accept=".nlogo,.nlogox" :disabled="busy || readingFile" @change="selectNetLogoFile" /></label>
        <p v-if="readingFile" role="status" class="field-note">Reading model…</p>
        <p v-else-if="netlogoFile" class="field-note">{{ netlogoFile.name }} <button type="button" class="quiet" :disabled="busy" @click="clearNetLogoFile">Remove</button></p>
        <p v-else-if="!fileError" class="field-note">Upload a NetLogo model, or start with an editable example.</p>
        <p v-if="fileError" role="alert" class="login-error">{{ fileError }} <button type="button" class="quiet" @click="clearNetLogoFile">Use example instead</button></p>
      </template>
      <template v-if="extraction"><p class="fork-revision">From {{ extraction.project.title }}</p><fieldset class="file-selection"><legend>Saved source files</legend><label v-for="file in extraction.files" :key="file.path"><input v-model="paths" type="checkbox" :value="file.path" :disabled="busy" />{{ file.path }}</label></fieldset></template>
      <label
        >Title<input
          v-model="title"
          maxlength="120"
          required
          autofocus
          :disabled="busy"
      /></label>
      <label v-if="!source && !extraction"
        >Description<textarea
          v-model="description"
          maxlength="4000"
          rows="3"
          :disabled="busy"
        />
      </label>
      <label v-if="!demoMode"
        >Visibility<select
          v-model="visibility"
          aria-label="Visibility"
          :disabled="busy || (source ?? extraction)?.project.visibility === 'private'"
        >
          <option value="private">Private</option>
          <option value="public">Public</option>
        </select></label
      >
      <p v-if="!demoMode && (source ?? extraction)?.project.visibility === 'private'" class="field-note">
        Copies of private projects stay private.
      </p>
      <p v-if="demoMode" class="field-note">Saved in this browser only. Export your workspace to keep a backup or move it to another browser.</p>
      <p v-if="error" role="alert" class="login-error">{{ error }}</p>
      <button
        v-if="!source && !extraction && !availableTemplates.length && !loading"
        type="button"
        class="quiet"
        @click="loadTemplates"
      >
        Retry templates
      </button>
      <button
        class="launch-button"
        type="submit"
        :disabled="
          busy || loading || readingFile || !!fileError || !title.trim() || (extraction && !paths.length) || (!source && !extraction && !availableTemplates.length)
        "
      >
        {{
          busy
            ? source
              ? "Forking…"
              : "Creating…"
            : source
              ? `Fork ${subject}`
              : extraction ? "Extract library" : `Create ${subject}`
        }}
      </button>
    </form>
  </dialog>
</template>
