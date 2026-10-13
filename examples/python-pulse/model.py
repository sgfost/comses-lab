from vendor.diffusion import diffuse


def simulate(steps=1, diffusivity=0.2):
    values = [0.0, 0.0, 100.0, 0.0, 0.0]
    for _ in range(steps):
        values = diffuse(values, diffusivity)
    return values
