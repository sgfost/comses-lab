"""A hot segment cooling around a circular conductor."""
from diffusion import diffuse


def simulate(steps=100, diffusivity=0.2):
    temperatures = [100.0 if 40 <= i < 60 else 0.0 for i in range(100)]
    for _ in range(steps):
        temperatures = diffuse(temperatures, diffusivity)
    print(f"Computed {steps} steps; diffusivity {diffusivity}")
    return temperatures
