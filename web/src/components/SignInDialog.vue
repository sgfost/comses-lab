<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
const props = defineProps<{ open: boolean; busy: boolean; error: string }>();
const emit = defineEmits<{
  close: [];
  submit: [username: string, password: string];
}>();
const dialog = ref<HTMLDialogElement>();
const username = ref("");
const password = ref("");
watch(
  () => props.open,
  async (open) => {
    await nextTick();
    if (open) dialog.value?.showModal();
    else {
      dialog.value?.close();
      password.value = "";
    }
  },
  { immediate: true },
);
</script>
<template>
  <dialog
    ref="dialog"
    class="login-dialog"
    aria-labelledby="sign-in-title"
    @close="emit('close')"
    @click="$event.target === dialog && emit('close')"
  >
    <form @submit.prevent="emit('submit', username, password)">
      <button
        type="button"
        class="close"
        aria-label="Close sign in"
        @click="emit('close')"
      >
        ×
      </button>
      <h2 id="sign-in-title">Sign in</h2>
      <label
        >Username<input
          v-model="username"
          name="username"
          autocomplete="username"
          required
          autofocus
      /></label>
      <label
        >Password<input
          v-model="password"
          name="password"
          type="password"
          autocomplete="current-password"
          required
      /></label>
      <p v-if="error" role="alert" class="login-error">{{ error }}</p>
      <button class="launch-button" type="submit" :disabled="busy">
        {{ busy ? "Signing in…" : "Sign in" }}
      </button>
    </form>
  </dialog>
</template>
