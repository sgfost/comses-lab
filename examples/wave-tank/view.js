import {WaveTank} from './model.js';
const $=id=>document.getElementById(id),canvas=$('world'),ctx=canvas.getContext('2d');
const layer=document.createElement('canvas');layer.width=180;layer.height=108;const lc=layer.getContext('2d'),pixels=lc.createImageData(180,108);
let model=new WaveTank(),running=true,last=0;
function draw(){let sum=0;for(let i=0;i<model.u.length;i++){const value=model.u[i],a=Math.min(1,Math.abs(value)*1.7),color=value>0?[113,220,231]:[147,110,230];sum+=value*value;for(let k=0;k<3;k++)pixels.data[i*4+k]=model.wall[i]?[174,193,204][k]:[12,22,34][k]+a*(color[k]-[12,22,34][k]);pixels.data[i*4+3]=255;}lc.putImageData(pixels,0,0);ctx.imageSmoothingEnabled=true;ctx.drawImage(layer,0,0,900,520);$('tick').textContent=model.tick;$('amplitude').textContent=Math.sqrt(sum/model.u.length).toFixed(3);$('cells').textContent=model.u.length.toLocaleString();$('status').textContent=`${running?'Running':'Paused'} · 2D wave equation · Click to add a pulse`;}
function reset(){model=new WaveTank();model.setBarrier($('barrier').value);draw();}
function step(){model.step(Number($('wavelength').value),$('source').value);}
$('play').onclick=()=>{running=!running;$('play').textContent=running?'Pause':'Play';draw();};$('step').onclick=()=>{running=false;$('play').textContent='Play';step();draw();};$('reset').onclick=reset;$('barrier').onchange=reset;$('source').onchange=reset;
canvas.onclick=e=>{const r=canvas.getBoundingClientRect();model.pulse((e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height);draw();};
for(const id of ['play','step','reset'])$(id).disabled=false;
// Start with established wave fronts so the initial view shows the experiment.
for(let i=0;i<420;i++)step();draw();
function frame(now){if(now-last>1000/30){if(running){for(let i=0;i<4;i++)step();draw();}last=now;}requestAnimationFrame(frame);}requestAnimationFrame(frame);
