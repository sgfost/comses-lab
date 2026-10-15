// u(t+1) = 2u(t) - u(t-1) + c² Laplacian(u), with graded edge damping.
export class WaveTank {
  constructor(){this.width=180;this.height=108;this.tick=0;const n=this.width*this.height;this.u=new Float32Array(n);this.previous=new Float32Array(n);this.next=new Float32Array(n);this.wall=new Uint8Array(n);this.setBarrier('double');}
  setBarrier(kind){this.wall.fill(0);if(kind==='none')return;for(let y=1;y<this.height-1;y++){const gap=kind==='single'?Math.abs(y-54)<5:Math.abs(y-39)<4||Math.abs(y-69)<4;if(!gap)for(let x=78;x<=80;x++)this.wall[y*this.width+x]=1;}}
  pulse(x,y){const cx=x*this.width,cy=y*this.height;for(let j=-6;j<=6;j++)for(let i=-6;i<=6;i++){const px=Math.floor(cx)+i,py=Math.floor(cy)+j;if(px>0&&px<this.width-1&&py>0&&py<this.height-1){const k=py*this.width+px;if(!this.wall[k])this.u[k]+=1.4*Math.exp(-(i*i+j*j)/9);}}}
  step(wavelength=24,source='plane'){
    const w=this.width,h=this.height,c=.45;
    for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){const k=y*w+x;if(this.wall[k]){this.next[k]=0;continue;}const edge=Math.min(x,y,w-1-x,h-1-y),damping=.001+Math.max(0,12-edge)/12*.16;this.next[k]=(2*this.u[k]-this.previous[k]+c*c*(this.u[k-1]+this.u[k+1]+this.u[k-w]+this.u[k+w]-4*this.u[k]))*(1-damping);}
    const drive=Math.sin(this.tick*c*2*Math.PI/wavelength)*.7;
    if(source==='plane')for(let y=14;y<h-14;y++)this.next[y*w+20]=drive;
    else this.next[54*w+25]=drive*2;
    [this.previous,this.u,this.next]=[this.u,this.next,this.previous];this.tick++;
  }
}
