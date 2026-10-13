<script setup lang="ts">
import type { LibraryDependency } from "../../../shared/contracts";
defineProps<{ libraries: LibraryDependency[] }>();
</script>
<template>
  <ul v-if="libraries.length" class="library-children">
    <li v-for="pin in libraries" :key="pin.directory">
      <a v-if="pin.project" class="dependency-link" :aria-label="pin.project.title" :href="`#/project/${pin.projectId}?ref=${pin.commit}`"><span class="dependency-title">{{ pin.project.title }} <span aria-hidden="true">↗</span></span><span v-if="pin.project.description" class="dependency-description">{{ pin.project.description }}</span></a><span v-else>Unavailable library</span>
      <div class="dependency-revision" :title="pin.commit">Installed version</div>
      <span v-if="pin.modified" class="pane-error">Installed files modified</span>
      <LibraryChildren :libraries="pin.children" />
    </li>
  </ul>
</template>
