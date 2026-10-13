"""Explicit heat diffusion on a periodic one-dimensional grid."""


def diffuse(values, diffusivity):
    if not 0 <= diffusivity <= 0.5:
        raise ValueError("Diffusivity must be between 0 and 0.5")
    return [
        value + diffusivity * (values[i - 1] - 2 * value + values[(i + 1) % len(values)])
        for i, value in enumerate(values)
    ]
