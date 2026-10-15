import {Encounter} from './model.js';
const $=id=>document.getElementById(id),canvas=$('world'),ctx=canvas.getContext('2d');
let model,running=true,last=0;
function reset(){if(!$('seed').checkValidity())return;model=new Encounter(Number($('seed').value),$('preset').value);ctx.fillStyle='#0c1622';ctx.fillRect(0,0,900,520);draw(true);}
function draw(clear=false){
  ctx.fillStyle=`rgba(12,22,34,${clear?1:1-Number($('trails').value)})`;ctx.fillRect(0,0,900,520);
  const scale=.94;ctx.save();ctx.translate(450,260);ctx.scale(scale,scale);ctx.globalCompositeOperation='lighter';
  for(const p of model.stars){ctx.fillStyle=p.disk?`rgba(255,176,119,${p.brightness})`:`rgba(120,194,255,${p.brightness})`;ctx.fillRect(p.x,p.y,1.5,1.5);}
  for(const p of model.cores){const glow=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,24);glow.addColorStop(0,'#fff9e0');glow.addColorStop(.15,'#e8ddc799');glow.addColorStop(1,'#e8ddc700');ctx.fillStyle=glow;ctx.fillRect(p.x-24,p.y-24,48,48);}
  ctx.restore();ctx.strokeStyle='#516270';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(24,490);ctx.lineTo(118,490);ctx.stroke();ctx.fillStyle='#8596a6';ctx.font='10px Arial';ctx.fillText('100 distance units',24,507);
  $('stars').textContent=model.stars.length.toLocaleString();$('separation').textContent=Math.hypot(model.cores[0].x-model.cores[1].x,model.cores[0].y-model.cores[1].y).toFixed(1);$('time').textContent=model.time.toFixed(1);$('status').textContent=`${running?'Running':'Paused'} · Restricted N-body · Fixed integration step`;
}
$('play').onclick=()=>{running=!running;$('play').textContent=running?'Pause':'Play';draw();};
$('step').onclick=()=>{running=false;$('play').textContent='Play';model.step();draw();};
$('reset').onclick=reset;$('preset').onchange=reset;
for(const id of ['play','step','reset'])$(id).disabled=false;
reset();
function frame(now){if(now-last>1000/30){if(running){for(let i=0;i<Number($('speed').value);i++)model.step();draw();}last=now;}requestAnimationFrame(frame);}requestAnimationFrame(frame);
