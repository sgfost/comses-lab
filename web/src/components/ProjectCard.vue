<script setup lang="ts">
import { computed } from "vue";
import type { Project } from "../../../shared/contracts";
const props = defineProps<{ project: Project }>();
const format = computed(() => {
  if (props.project.kind === "library") return "Library";
  const path = props.project.entrypoint;
  if (/\.nlogo[x]?$/i.test(path)) return "NetLogo";
  if (/\.py$/i.test(path)) return "Python";
  if (/\.[cm]?js$/i.test(path)) return "JavaScript";
  if (/\.html?$/i.test(path)) return "Web";
  return "Artifact";
});
</script>

<template>
  <a :href="`#/project/${project.id}`" class="model-row">
    <div class="model-card-body">
      <div class="model-card-heading"><span class="model-format">{{ format }}</span><span v-if="project.visibility === 'private'" class="model-visibility">Private</span></div>
      <div class="model-name">
        <h2>{{ project.title }}</h2>
        <span>{{ project.ownerName }}</span>
        <p v-if="project.description" class="catalog-description">{{ project.description }}</p>
      </div>
      <div class="model-meta"><span>{{ project.license || 'No license' }}</span><span class="model-open" aria-hidden="true">→</span></div>
    </div>
  </a>
</template>
