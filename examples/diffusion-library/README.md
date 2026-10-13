# Diffusion

An ordinary Python module providing `diffuse(values, diffusivity)`, one step of diffusion with periodic boundaries. Heat pulse and Alternating temperatures use this library through normal `from vendor.diffusion import diffuse` imports.

Install `diffusion.py` into `vendor`. The library revision and copied file checksum are recorded in the consuming project's `lab.lock.json`. You can inspect, fork and update this library independently of its models.

The initial implementation is copied from the earlier Heat diffusion example; it has the same bytes as the previously pinned shared component. No Lab runtime API is required.
