import {PT} from './engine.mjs';
const grid=1000/PT;
const edgeTable=[[],[[0,3]],[[1,0]],[[1,3]],[[2,1]],[[0,3],[2,1]],[[2,0]],[[2,3]],
  [[3,2]],[[0,2]],[[1,0],[3,2]],[[1,2]],[[3,1]],[[0,1]],[[3,0]],[]];
const distance=(a,b,c,r,g,h)=>Math.hypot(a-r,b-g,c-h)/Math.sqrt(3);
const toPath=(poly)=>[...poly.map(({X,Y},i)=>[i?'l':'m',X/grid,Y/grid]),['h']];

function maskFrom({data,width,height},tolerance) {
  const mask=new Uint8Array(width*height);
  const inset=Math.min(2,Math.floor(Math.min(width,height)/4));
  let transparent=0, samples=0;
  const check=(x,y)=>{ samples++; if(data[(y*width+x)*4+3]<32) transparent++; };
  for(let x=inset;x<width-inset;x++){
    check(x,inset); check(x,height-1-inset);
  }
  for(let y=inset;y<height-inset;y++){
    check(inset,y); check(width-1-inset,y);
  }
  if(transparent>samples*.08){
    for(let i=0;i<mask.length;i++) mask[i]=Number(data[i*4+3]>=128);
    return mask;
  }
  const corners=[[0,0],[width-1,0],[0,height-1],[width-1,height-1]].map(([x,y])=>{
    const colors=[[],[],[]];
    for(let j=0;j<Math.min(5,height);j++) for(let i=0;i<Math.min(5,width);i++){
      const at=4*((y?y-j:j)*width+(x?x-i:i));
      for(let c=0;c<3;c++) colors[c].push(data[at+c]);
    }
    return colors.map((v)=>v.sort((a,b)=>a-b)[Math.floor(v.length/2)]);
  });
  const best=corners.map((a)=>corners.filter((b)=>distance(...a,...b)<=tolerance))
    .reduce((a,b)=>a.length>=b.length?a:b);
  if(best.length<2) throw new Error('El fondo no parece uniforme. Ajusta la tolerancia o usa un fondo liso o transparente.');
  const [r,g,b]=best[0].map((_,i)=>best.reduce((n,p)=>n+p[i],0)/best.length);
  const limit=3*tolerance*tolerance;
  for(let i=0;i<mask.length;i++){
    const j=4*i;
    mask[i]=Number(data[j+3]>=128 && (data[j]-r)**2+(data[j+1]-g)**2+(data[j+2]-b)**2>limit);
  }
  return mask;
}

function borders(mask,width,height) {
  const stride=width*2+3, next=new Map();
  const pixel=(x,y)=>x<0||y<0||x>=width||y>=height?0:mask[y*width+x];
  for(let y=-1;y<height;y++) for(let x=-1;x<width;x++){
    const edges=edgeTable[pixel(x,y)+2*pixel(x+1,y)+4*pixel(x+1,y+1)+8*pixel(x,y+1)];
    if(!edges.length) continue;
    const base=(2*y+2)*stride+2*x+2;
    const points=[base+1,base+stride+2,base+2*stride+1,base+stride];
    for(const [a,b] of edges) next.set(points[a],points[b]);
    if(next.size>200000) throw new Error('La imagen tiene demasiados bordes. Sube la tolerancia o simplifica el fondo.');
  }
  const paths=[];
  while(next.size){
    const start=next.keys().next().value, path=[];
    let point=start;
    do {
      if(point===undefined) throw new Error('No se pudo cerrar la silueta detectada.');
      path.push({X:(point%stride-1)/2,Y:(Math.floor(point/stride)-1)/2});
      const following=next.get(point);
      next.delete(point);
      point=following;
    } while(point!==start);
    paths.push(path);
  }
  return paths;
}

function segmentDistance([x,y],[a,b],[c,d]){
  const dx=c-a,dy=d-b,len=dx*dx+dy*dy;
  const t=len?Math.max(0,Math.min(1,((x-a)*dx+(y-b)*dy)/len)):0;
  return (x-a-t*dx)**2+(y-b-t*dy)**2;
}

function simplify(ring,epsilon){
  const first=ring.reduce((i,p,j)=>p.X<ring[i].X?j:i,0);
  const last=ring.reduce((i,p,j)=>p.X>ring[i].X?j:i,0);
  if(first===last) return [];
  const points=ring.slice(first).concat(ring.slice(0,first+1));
  const split=(last-first+ring.length)%ring.length;
  const pending=[[0,split],[split,points.length-1]], keep=new Set([0,split]);
  while(pending.length){
    const [start,end]=pending.pop();
    const a=[points[start].X,points[start].Y], b=[points[end].X,points[end].Y];
    let max=epsilon**2,pivot=-1;
    for(let i=start+1;i<end;i++){
      const error=segmentDistance([points[i].X,points[i].Y],a,b);
      if(error>max){ max=error; pivot=i; }
    }
    if(pivot>=0){ keep.add(pivot); pending.push([start,pivot],[pivot,end]); }
  }
  return points.slice(0,-1).filter((_,i)=>keep.has(i));
}

export function detect(image,box,tolerance){
  if(!Number.isFinite(tolerance)||tolerance<1||tolerance>120) throw new Error('Introduce una tolerancia entre 1 y 120.');
  const {Clipper,PolyFillType}=globalThis.ClipperLib;
  const {width,height}=image;
  const [left,bottom,right,top]=box;
  const sx=(right-left)/width,sy=(top-bottom)/height;
  const epsilon=Math.max(75,Math.min(220,Math.max(sx,sy)*grid*.85));
  const paths=borders(maskFrom(image,tolerance),width,height)
    .filter((path)=>{
      const area=Clipper.Area(path);
      return area>=Math.max(8,.12*PT*PT/(sx*sy)) && area<.997*width*height;
    })
    .map((path)=>simplify(path.map(({X,Y})=>({
      X:Math.round((left+X*sx)*grid),Y:Math.round((top-Y*sy)*grid)
    })),epsilon))
    .filter((path)=>path.length>=3);
  const merged=Clipper.SimplifyPolygons(paths,PolyFillType.pftNonZero);
  if(!merged.length) throw new Error('No se distingue una silueta. Ajusta la tolerancia o usa un fondo liso que contraste.');
  return merged.map(toPath);
}

const mid=([a,b],[c,d])=>[(a+c)/2,(b+d)/2];

function flatten(vertices,a,b,c,d,depth=0){
  if(depth>=16 || Math.max(segmentDistance(b,a,d),segmentDistance(c,a,d))<=(.025*PT)**2){
    vertices.push(d); return;
  }
  const ab=mid(a,b),bc=mid(b,c),cd=mid(c,d);
  const left=mid(ab,bc),right=mid(bc,cd),center=mid(left,right);
  flatten(vertices,a,ab,left,center,depth+1);
  flatten(vertices,center,right,cd,d,depth+1);
}

function polygonsFrom(paths){
  const polygons=[];
  for(const path of paths){
    let vertices=[];
    const close=(explicit)=>{
      if(vertices.length<=1){ vertices=[]; return; }
      if(!explicit && segmentDistance(vertices.at(-1),vertices[0],vertices[0])>(.02*PT)**2)
        throw new Error('Para desplazar el CutContour original, cierra sus trazados o usa la detección automática.');
      polygons.push(vertices.map(([x,y])=>({X:Math.round(x*grid),Y:Math.round(y*grid)})));
      vertices=[];
    };
    for(const [op,...xy] of path){
      if(op==='h') close(true);
      if(op==='m'){ close(false); vertices.push(xy); }
      if(op==='l') vertices.push(xy);
      if(op==='c') flatten(vertices,vertices.at(-1),xy.slice(0,2),xy.slice(2,4),xy.slice(4));
    }
    close(false);
  }
  return polygons;
}

export function offsetPaths(paths,mm,automatic=false){
  if(!Number.isFinite(mm)||Math.abs(mm)>5080) throw new Error('Introduce un desplazamiento entre −5.080 y +5.080 mm.');
  if(!mm) return paths;
  const lib=globalThis.ClipperLib;
  const polygons=lib.Clipper.SimplifyPolygons(polygonsFrom(paths),automatic ? lib.PolyFillType.pftNonZero : lib.PolyFillType.pftEvenOdd);
  const offset=new lib.ClipperOffset(2,25), result=new lib.Paths();
  offset.AddPaths(polygons,lib.JoinType.jtRound,lib.EndType.etClosedPolygon);
  offset.Execute(result,Math.round(mm*1000));
  if(!result.length) throw new Error('El corte desaparece con este ajuste. Reduce los milímetros hacia dentro.');
  return result.map(toPath);
}
