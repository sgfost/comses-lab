const $ = id => document.getElementById(id);
const canvas = $('world'), ctx = canvas.getContext('2d');
let worker, ready = false, busy = false, running = true, state, history = [];
const ants = document.title === 'Ant trails';
function send(action, extra = {}) {
  if (!ready || busy) return;
  busy = true;
  worker.postMessage({action, parameter: Number($('parameter').value), ...extra});
}
function reset() {
  if (!$('seed').checkValidity() || busy) return;
  history = []; running = false; $('play').textContent = 'Play';
  send('reset', {seed: Number($('seed').value), population: Number($('population').value)});
}
function draw(s) {
  state = s;
  const w = canvas.width / s.width, h = canvas.height / s.height;
  ctx.fillStyle = '#0c1622'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (ants) {
    for (let i = 0; i < s.trail.length; i++) {
      const v = Math.min(1, s.trail[i] / 12);
      if (v > .005) { ctx.fillStyle = `rgba(45,173,210,${v*.8})`; ctx.fillRect((i%s.width)*w, Math.floor(i/s.width)*h,w+1,h+1); }
      if (s.food[i]) { ctx.fillStyle = `rgba(111,225,176,${.35+s.food[i]/40})`; ctx.fillRect((i%s.width)*w,Math.floor(i/s.width)*h,w,h); }
    }
    ctx.strokeStyle='#ffca77';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(s.nest[0]*w,s.nest[1]*h,18,0,Math.PI*2);ctx.stroke();
    ctx.fillStyle='#ffca77';ctx.beginPath();ctx.arc(s.nest[0]*w,s.nest[1]*h,7,0,Math.PI*2);ctx.fill();
    for(const [x,y,a,carrying] of s.ants) {
      ctx.strokeStyle=carrying?'#ffcf83':'#e8f3fb';ctx.lineWidth=1.8;ctx.beginPath();ctx.moveTo(x*w-Math.cos(a)*2,y*h-Math.sin(a)*2);ctx.lineTo(x*w+Math.cos(a)*2,y*h+Math.sin(a)*2);ctx.stroke();
    }
    $('delivered').textContent=s.delivered; $('agents').textContent=s.agents; $('tick').textContent=s.tick;
  } else {
    for(let i=0;i<s.grass.length;i++){const g=s.grass[i];ctx.fillStyle=`rgb(${14+g*28},${30+g*65},${32+g*30})`;ctx.fillRect((i%s.width)*w,Math.floor(i/s.width)*h,w+1,h+1);}
    ctx.fillStyle='#f3dfae'; for(const [x,y] of s.grazers){ctx.beginPath();ctx.arc((x+.5)*w,(y+.5)*h,2.7,0,Math.PI*2);ctx.fill();}
    ctx.fillStyle='#f17d77'; for(const [x,y] of s.predators){ctx.beginPath();ctx.moveTo((x+.5)*w,(y+.1)*h);ctx.lineTo((x+.9)*w,(y+.85)*h);ctx.lineTo((x+.1)*w,(y+.85)*h);ctx.fill();}
    $('grazers').textContent=s.grazers.length;$('predators').textContent=s.predators.length;$('grass').textContent=Math.round(s.grass.reduce((a,b)=>a+b,0)/s.grass.length*100)+'%';
    if(history.at(-1)?.[0]!==s.tick)history.push([s.tick,s.grazers.length,s.predators.length]);if(history.length>240)history.shift();
    const chart=$('chart'), c=chart.getContext('2d');c.clearRect(0,0,900,100);const max=Math.max(100,...history.map(p=>Math.max(p[1],p[2])));
    c.font='11px Arial';c.fillStyle='#94a6b4';c.fillText('Population · '+max,12,17);
    for(const [column,color] of [[1,'#f3dfae'],[2,'#f17d77']]){c.strokeStyle=color;c.lineWidth=2;c.beginPath();history.forEach((p,i)=>{const x=12+i/239*876,y=90-p[column]/max*64;i?c.lineTo(x,y):c.moveTo(x,y);});c.stroke();}
  }
  $('status').textContent=`Python · Step ${s.tick} · ${running?'Running':'Paused'}`;
}
$('play').onclick=()=>{running=!running;$('play').textContent=running?'Pause':'Play';if(state)draw(state);};
$('step').onclick=()=>{running=false;$('play').textContent='Play';send('step',{steps:1});};
$('reset').onclick=reset;
canvas.onclick=event=>{const box=canvas.getBoundingClientRect();send('pointer',{x:(event.clientX-box.left)/box.width,y:(event.clientY-box.top)/box.height});};
const url=URL.createObjectURL(new Blob([`import(${JSON.stringify(new URL('./python-worker.js',import.meta.url).href)}).catch(error=>postMessage({type:'error',text:String(error)}));`],{type:'text/javascript'}));
worker=new Worker(url);
function fail(message){running=false;busy=false;$('status').textContent=message;for(const id of ['play','step','reset'])$(id).disabled=true;}
worker.onerror=event=>fail(event.message||'Python worker failed');
worker.onmessage=({data})=>{
  if(data.type==='ready'){console.info('Python interpreter ready; agent rules execute in model.py');URL.revokeObjectURL(url);ready=true;for(const id of ['play','step','reset'])$(id).disabled=false;send('reset',{seed:42,population:Number($('population').value)});}
  else if(data.type==='state'){busy=false;draw(data.state);}
  else if(data.type==='error')fail(data.text);
};
setInterval(()=>{if(running)send('step',{steps:ants?3:1});},80);
