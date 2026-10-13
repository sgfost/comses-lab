import { nextSeason } from './ecology.js';
const canvas = document.querySelector('canvas');
const context = canvas.getContext('2d');
const pressure = document.querySelector('#pressure');
let resources = Array.from({ length: 180 }, (_, i) => 60 + (i * 17 % 40));
let season = 0;
function draw() {
  context.clearRect(0, 0, canvas.width, canvas.height);
  resources.forEach((value, i) => {
    const x = 30 + (i % 15) * 39;
    const y = 35 + Math.floor(i / 15) * 36;
    const radius = 3 + value / 11;
    context.fillStyle = `hsl(${80 + value * 0.6} 25% ${70 - value * 0.35}%)`;
    context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill();
  });
  document.querySelector('#season').textContent = String(season);
  document.querySelector('#resources').textContent = `${Math.round(resources.reduce((a, b) => a + b, 0) / resources.length)}%`;
}
pressure.addEventListener('input', () => { document.querySelector('#pressure-value').textContent = `${pressure.value}%`; });
document.querySelector('#advance').addEventListener('click', () => { resources = nextSeason(resources, Number(pressure.value)); season++; draw(); });
document.querySelector('#reset').addEventListener('click', () => { resources = Array.from({ length: 180 }, (_, i) => 60 + (i * 17 % 40)); season = 0; draw(); });
draw();
