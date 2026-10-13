# The commons garden

A deliberately small model of a shared resource landscape. Each cell regrows by eight points per season and loses `0.2 × harvesting pressure` points, bounded between zero and 100. Initial resource levels are deterministic.

Open `index.html` through any static web server. The application has its own controls and canvas; `garden.js` imports the ordinary `ecology.js` module. No Lab SDK or model API is required.

This example illustrates an interaction, not a validated ecological forecast.

License: MIT. Copyright 2026 CoMSES Lab contributors.
