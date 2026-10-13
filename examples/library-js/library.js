/** Clamp a number to a closed interval. */
export function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
