// A cell regrows by eight points, then loses resources to harvesting.
export function nextSeason(resources, pressure) {
  return resources.map(value => Math.max(0, Math.min(100, value + 8 - pressure * 0.2)));
}
