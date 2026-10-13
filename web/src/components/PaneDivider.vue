<script setup lang="ts">
import { onUnmounted } from "vue";
const props = withDefaults(
  defineProps<{
    label: string;
    orientation?: "vertical" | "horizontal";
    value: number;
    min: number;
    max: number;
    step?: number;
    scale?: number;
    reverse?: boolean;
    collapseBelow?: number;
  }>(),
  { orientation: "vertical", step: 16, scale: 1, reverse: false },
);
const emit = defineEmits<{ "update:value": [value: number]; collapse: [] }>();
let cleanup: (() => void) | undefined;
function update(value: number) {
  if (props.collapseBelow !== undefined && value <= props.collapseBelow) { emit("collapse"); return; }
  emit("update:value", Math.max(props.min, Math.min(props.max, value)));
}
function drag(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  cleanup?.();
  const start =
    props.orientation === "vertical" ? event.clientX : event.clientY;
  const initial = props.value;
  const target = event.currentTarget as HTMLElement;
  target.focus();
  const move = (next: PointerEvent) => {
    const position =
      props.orientation === "vertical" ? next.clientX : next.clientY;
    update(
      initial + (position - start) * props.scale * (props.reverse ? -1 : 1),
    );
  };
  cleanup = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
    document.body.classList.remove("resizing");
    cleanup = undefined;
  };
  const end = () => cleanup?.();
  document.body.classList.add("resizing");
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end, { once: true });
  window.addEventListener("pointercancel", end, { once: true });
}
function keydown(event: KeyboardEvent) {
  const decrease = props.orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
  const increase =
    props.orientation === "vertical" ? "ArrowRight" : "ArrowDown";
  if (event.key === "Home") update(props.min);
  else if (event.key === "End") update(props.max);
  else if (event.key === decrease || event.key === increase) {
    update(
      props.value +
        (event.key === increase ? 1 : -1) *
          props.step *
          (props.reverse ? -1 : 1),
    );
  } else return;
  event.preventDefault();
}
onUnmounted(() => cleanup?.());
</script>

<template>
  <div
    class="splitter"
    :class="{ horizontal: orientation === 'horizontal' }"
    role="separator"
    :aria-label="label"
    :title="collapseBelow !== undefined ? 'Drag left to close code' : label"
    :aria-orientation="orientation"
    :aria-valuenow="Math.round(value)"
    :aria-valuemin="min"
    :aria-valuemax="max"
    tabindex="0"
    @pointerdown="drag"
    @keydown="keydown"
  ></div>
</template>
