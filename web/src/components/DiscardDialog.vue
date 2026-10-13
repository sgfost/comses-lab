<script setup lang="ts">
import { ref, onUnmounted } from "vue";
const dialog = ref<HTMLDialogElement>();
const detail = ref("");
let finish: ((discard: boolean) => void) | undefined;
let pending: Promise<boolean> | undefined;
function answer(discard: boolean) {
  dialog.value?.close();
  finish?.(discard);
  finish = undefined;
  pending = undefined;
}
function confirm(message = "Your unsaved changes will be lost.") {
  if (pending) return pending;
  detail.value = message;
  pending = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  dialog.value?.showModal();
  return pending;
}
onUnmounted(() => answer(false));
defineExpose({ confirm });
</script>
<template>
  <dialog
    ref="dialog"
    class="login-dialog discard-dialog"
    aria-labelledby="discard-title"
    @cancel.prevent="answer(false)"
    @click="$event.target === dialog && answer(false)"
  >
    <h2 id="discard-title">Discard changes?</h2>
    <p>{{ detail }}</p>
    <div class="dialog-actions">
      <button class="quiet" autofocus @click="answer(false)">Stay</button>
      <button class="launch-button" @click="answer(true)">
        Discard changes
      </button>
    </div>
  </dialog>
</template>
