// Restricted N-body model: mutually attracting cores and massless tracer stars.
const G = 1, SOFTENING = 16, DT = .13;
export class Encounter {
  constructor(seed=42,preset='prograde') {
    let value=seed>>>0;
    const random=()=>((value=(Math.imul(value,1664525)+1013904223)>>>0)/4294967296);
    this.time=0;this.cores=[{x:-155,y:-55,vx:1.05,vy:.05,m:1800},{x:155,y:55,vx:-1.05,vy:-.05,m:1500}];
    if(preset==='wide'){this.cores[0].y=-110;this.cores[1].y=110;}
    this.stars=[];
    for(let disk=0;disk<2;disk++)for(let i=0;i<800;i++){
      const r=15+Math.sqrt(random())*90,a=random()*Math.PI*2,c=this.cores[disk];
      const speed=Math.sqrt(G*c.m*r*r/Math.pow(r*r+SOFTENING**2,1.5));
      const direction=disk===1&&preset==='retrograde'?-1:1;
      this.stars.push({x:c.x+r*Math.cos(a),y:c.y+r*Math.sin(a),vx:c.vx-direction*speed*Math.sin(a),vy:c.vy+direction*speed*Math.cos(a),disk,brightness:.35+random()*.65});
    }
  }
  acceleration(p,skip=-1){let ax=0,ay=0;this.cores.forEach((c,i)=>{if(i===skip)return;const dx=c.x-p.x,dy=c.y-p.y,f=G*c.m/Math.pow(dx*dx+dy*dy+SOFTENING**2,1.5);ax+=dx*f;ay+=dy*f;});return[ax,ay];}
  step(){
    const bodies=[...this.cores,...this.stars];
    bodies.forEach((p,i)=>{const [ax,ay]=this.acceleration(p,i<2?i:-1);p.vx+=ax*DT/2;p.vy+=ay*DT/2;});
    for(const p of bodies){p.x+=p.vx*DT;p.y+=p.vy*DT;}
    bodies.forEach((p,i)=>{const [ax,ay]=this.acceleration(p,i<2?i:-1);p.vx+=ax*DT/2;p.vy+=ay*DT/2;});
    this.time+=DT;
  }
}
