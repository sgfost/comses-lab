<script setup lang="ts">
import { defineAsyncComponent } from "vue";
const SourceEditor = defineAsyncComponent(() => import("./SourceEditor.vue"));
defineProps<{
  patch: string;
  commit: string;
  base: string | null;
}>();
</script>
<template>
  <div class="diff-view">
    <div class="diff-summary">
      <span>{{
        base
          ? `${base.slice(0, 8)} → ${commit.slice(0, 8)}`
          : `Initial commit ${commit.slice(0, 8)}`
      }}</span>
    </div>
    <div v-if="!patch" class="empty">No changes.</div>
    <SourceEditor
      v-else
      :content="patch"
      path="commit.diff"
      label="Commit diff"
    />
  </div>
</template>
