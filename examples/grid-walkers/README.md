# Grid walkers

200 agents take seeded random steps on a periodic grid. Multiple agents can share a cell. The model defines only its movement rule and configuration.

Dependency hierarchy:

```
Grid walkers
└── Agent grid — agents, seeded randomness, scheduler, grid rendering
    └── Browser kit — canvas, controls, status, animation loop
```

The Libraries panel shows the recorded revisions. All library code is present in the repository under `vendor/`, with ordinary relative JavaScript imports. No package install or Lab API is needed to serve this model as a static website. Updates are explicit commits; selecting an older model commit retains the complete older dependency tree.
