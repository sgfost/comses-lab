import type { ProjectTemplate } from "./contracts.ts";

export const showcaseTemplates: (ProjectTemplate & { files: string[] })[] = [
  { kind: "model", id: "ant-trails", title: "Ant trails", description: "Python foraging agents with local sensing, pheromone trails, and finite food patches.", entrypoint: "index.html", license: "MIT", files: ["index.html", "style.css", "view.js", "python-worker.js", "model.py", "README.md"] },
  { kind: "model", id: "predator-prey", title: "Predator–prey landscape", description: "A Python agent-based ecosystem with grazing, hunting, reproduction, and population histories.", entrypoint: "index.html", license: "MIT", files: ["index.html", "style.css", "view.js", "python-worker.js", "model.py", "README.md"] },
  { kind: "model", id: "galaxy-encounter", title: "Galaxy encounter", description: "1,600 tracer stars in a two-core gravitational encounter, with tidal tails and orbital trails.", entrypoint: "index.html", license: "MIT", files: ["index.html", "style.css", "view.js", "model.js", "README.md"] },
  { kind: "model", id: "wave-tank", title: "Wave interference", description: "Interactive wave propagation, diffraction, and interference through configurable barriers.", entrypoint: "index.html", license: "MIT", files: ["index.html", "style.css", "view.js", "model.js", "README.md"] },
];

export const templates: (ProjectTemplate & { files: string[] })[] = [
  ...showcaseTemplates,
  { kind: "model", id: "commons", title: "The commons garden", description: "A resource regeneration and harvesting model.", entrypoint: "index.html", license: "MIT", files: ["index.html", "garden.js", "ecology.js", "README.md"] },
  { kind: "model", id: "worker", title: "Random walks", description: "Random walks computed in a JavaScript worker.", entrypoint: "index.html", license: "MIT", files: ["index.html", "walk.js", "walk-worker.js", "random.js", "README.md"] },
  { kind: "model", id: "python", title: "Heat diffusion", description: "Heat diffusion computed in Python with Pyodide.", entrypoint: "index.html", license: "MIT", files: ["index.html", "heat.js", "python-worker.js", "model.py", "diffusion.py", "README.md"] },
  { kind: "model", id: "netlogo", title: "NetLogo", description: "A NetLogo model running in NetLogo Web.", entrypoint: "model.nlogox", license: "MIT", files: ["model.nlogox", "README.md", "LICENSE"] },
  { kind: "library", id: "library-python", title: "Python library", description: "An ordinary Python module.", entrypoint: "", license: "MIT", files: ["library.py", "README.md", "LICENSE"] },
  { kind: "library", id: "library-js", title: "JavaScript library", description: "An ordinary JavaScript module.", entrypoint: "", license: "MIT", files: ["library.js", "README.md", "LICENSE"] },
];
