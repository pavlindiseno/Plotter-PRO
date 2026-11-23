import {PT, inspect, openImage, artworkSize, scaleSource, withContour, layout, build, renderSource, sample} from './engine.mjs?v=5';
import {detect, offsetPaths} from './contour.mjs';

const by = (id) => document.getElementById(id);
const fmt = (value) => value.toLocaleString('es-ES', {maximumFractionDigits:2});
const model = {original:null, source:null, plan:null, name:'', page:0, mode:'print', version:0, thumb:null, raster:null, thumbError:false, detection:null, geometry:null, sized:null, urls:[], busy:false, zoom:1, displayScale:0, zoomAnchor:null};
const fileField = by('file');
const drop = by('drop');
const canvas = by('canvas');
const viewport = by('viewport');
let renderFrame = 0;
let pdfjs;

function note(id, message, error = false) {
  const element = by(id);
  element.hidden = !message;
  element.textContent = message;
  if (!id.endsWith('-error')) element.classList.toggle('error', error);
}

function refreshButtons() {
  by('prepare').disabled = !model.plan || model.busy;
  by('export-files').hidden = !model.urls.length;
}

function clearExports() {
  for (const key of ['print','cut']) {
    by(key).removeAttribute('href');
    by('open-'+key).removeAttribute('href');
  }
  for (const url of model.urls) {
    setTimeout(() => URL.revokeObjectURL(url),60000);
  }
  model.urls=[];
}

function updateZoom(zoom,anchorX=viewport.clientWidth/2,anchorY=viewport.clientHeight/2) {
  const next=Math.max(.5,Math.min(8,zoom));
  if (!model.plan || next===model.zoom) return;
  const rect=canvas.getBoundingClientRect(), frame=viewport.getBoundingClientRect();
  if (model.displayScale) {
    model.zoomAnchor={
      x:(frame.left+anchorX-rect.left)/model.displayScale,
      y:(frame.top+anchorY-rect.top)/model.displayScale,
      anchorX, anchorY,
    };
  }
  model.zoom=next;
  scheduleDraw();
}

function scheduleDraw() {
  cancelAnimationFrame(renderFrame);
  renderFrame = requestAnimationFrame(draw);
}

function sizedOriginal(original) {
  const mode=by('size-mode').value;
  const value=by('size-value').valueAsNumber;
  const referenceWidth=by('reference-width').valueAsNumber;
  by('size-label').textContent=mode==='percent' ? 'Escala' : mode==='height' ? 'Altura' : 'Anchura';
  by('size-unit').textContent=mode==='percent' ? '%' : 'mm';
  by('reference-sizing').hidden=!(original.image && mode==='percent');
  const key=JSON.stringify([mode,value,referenceWidth]);
  if (model.sized?.key!==key) model.sized={key,source:scaleSource(original,mode,value,referenceWidth)};
  const {width,height}=artworkSize(model.sized.source);
  note('size-result',fmt(width)+' × '+fmt(height)+' mm de ancho × alto antes del recorte.');
  return model.sized.source;
}

function updateGeometry() {
  const original=model.original;
  model.source=null;
  note('contour-error','');
  note('size-error','');
  note('size-result','');
  by('size-settings').hidden=!original;
  by('contour-settings').hidden=!original;
  if (!original) return;

  const automatic=by('contour-mode').value==='automatic';
  const millimeters=by('offset').valueAsNumber;
  const tolerance=by('tolerance').valueAsNumber;
  by('tolerance-setting').hidden=!automatic;
  by('source-mode').hidden=!original.paths.length;
  let source;
  try { source=sizedOriginal(original); }
  catch (error) {
    note('file-status','');
    note('size-error',error.message);
    return;
  }
  if (automatic && !model.raster) {
    note('file-status',model.thumbError ? '' : 'Detectando la silueta…');
    if (model.thumbError) note('contour-error','No se pudo renderizar el archivo para detectar la silueta.');
    return;
  }
  const key=JSON.stringify([automatic,millimeters,tolerance,model.sized.key]);
  try {
    if (model.geometry?.key===key) {
      model.source=model.geometry.source;
    } else {
      let paths=source.paths;
      if (automatic) {
        const detectorKey=JSON.stringify([tolerance,model.sized.key]);
        if (model.detection?.key!==detectorKey) model.detection={key:detectorKey,paths:detect(model.raster,source.artwork,tolerance)};
        paths=model.detection.paths;
      }
      model.source=withContour(source,offsetPaths(paths,millimeters,automatic));
      model.geometry={key,source:model.source};
    }
    note('file-status',automatic ? 'Silueta detectada' : 'CutContour detectado');
  } catch (error) {
    note('file-status','');
    note('contour-error',error.message);
  }
}

function recompute() {
  model.plan = null;
  clearExports();
  model.busy = false;
  note('export-status', '');
  note('layout-error', '');
  updateGeometry();
  if (model.source) {
    const options = Object.fromEntries(['roll','quantity','gap','margin'].map((key) => [key, by(key).valueAsNumber]));
    options.bleed = by('bleed').value === '' && !by('bleed').validity.badInput ? null : by('bleed').valueAsNumber;
    if (options.bleed==null && (by('offset').valueAsNumber || by('contour-mode').value==='automatic')) {
      options.bleed=Number.isFinite(options.gap) ? Math.min(1,Math.max(0,options.gap/2)) : 1;
    }
    try { model.plan = layout(model.source, options); }
    catch (error) { note('layout-error', error.message); }
  }
  const plan = model.plan;
  model.page = Math.min(model.page, (plan?.panels.length ?? 1)-1);
  by('empty').hidden = !!plan;
  by('sheet').hidden = !plan;
  by('zoom-tools').hidden = !plan;
  by('page-control').hidden = !(plan?.panels.length > 1);
  by('panel').replaceChildren(...(plan?.panels ?? []).map((panel,index) => {
    const option = document.createElement('option');
    option.value = index;
    option.textContent = (index+1)+' de '+plan.panels.length+' · '+fmt(panel.length)+' mm';
    return option;
  }));
  by('panel').value = model.page;
  by('stat-count').textContent = plan ? fmt(plan.quantity) : '—';
  by('stat-grid').textContent = plan ? fmt(plan.columns)+' × '+fmt(plan.rows) : '—';
  by('stat-length').textContent = plan ? fmt(plan.total)+' mm' : '—';
  by('proof-info').textContent = model.source
    ? 'Etiqueta de '+fmt(model.source.sourceWidth)+' × '+fmt(model.source.sourceHeight)+' mm'
    : model.original ? 'Ajusta la línea de corte para ver el montaje.' : 'Carga un archivo para calcular el montaje.';
  refreshButtons();
  scheduleDraw();
}

async function thumbnail(source) {
  pdfjs ??= import('./vendor/pdf.mjs').then((module) => {
    module.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', import.meta.url).href;
    return module;
  });
  const data=await renderSource(source);
  const module = await pdfjs;
  const task = module.getDocument({data,isEvalSupported:false,
    cMapUrl:new URL('./vendor/cmaps/',import.meta.url).href, cMapPacked:true,
    standardFontDataUrl:new URL('./vendor/standard_fonts/',import.meta.url).href});
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const original = page.getViewport({scale:1});
    const view = page.getViewport({scale:Math.min(6,1800/Math.max(original.width,original.height))});
    const target = document.createElement('canvas');
    target.width = Math.max(1,Math.ceil(view.width));
    target.height = Math.max(1,Math.ceil(view.height));
    const ctx=target.getContext('2d',{willReadFrequently:true});
    const transform=[target.width/view.width,0,0,target.height/view.height,0,0];
    await page.render({canvasContext:ctx,viewport:view,transform,background:'rgba(0,0,0,0)'}).promise;
    return {image:target,raster:ctx.getImageData(0,0,target.width,target.height)};
  } finally {
    await task.destroy();
  }
}

function changeView(mode) {
  model.mode=mode;
  for (const type of ['print','overlay','cut']) by('show-'+type).setAttribute('aria-pressed',mode===type);
  scheduleDraw();
}

async function load(name,read) {
  const version=++model.version;
  Object.assign(model,{original:null,source:null,name,thumb:null,raster:null,thumbError:false,page:0,detection:null,geometry:null,sized:null,zoom:1,displayScale:0,zoomAnchor:null});
  by('filename').hidden=false;
  by('filename').textContent=name;
  by('filemeta').textContent='Leyendo archivo…';
  by('offset').value=0;
  note('file-status','');
  recompute();
  try {
    const bytes=new Uint8Array(await read());
    const jpg=bytes[0]===255 && bytes[1]===216;
    const png=bytes[0]===137 && bytes[1]===80 && bytes[2]===78 && bytes[3]===71;
    const pdf=new TextDecoder('latin1').decode(bytes.subarray(0,1024)).includes('%PDF-');
    if (!pdf && !jpg && !png) throw new Error('Selecciona un PDF, JPG o PNG.');
    const source=jpg || png ? await openImage(bytes,png?'png':'jpg') : await inspect(bytes,{allowNoCut:true});
    if (version!==model.version) return;
    model.original=source;
    by('file-icon').textContent=jpg?'JPG':png?'PNG':'PDF';
    by('size-mode').value=source.image ? 'width' : 'percent';
    by('size-value').value=source.image ? '' : '100';
    by('reference-width').value='';
    by('filemeta').textContent=source.image ? 'Indica el tamaño real antes de montar' : 'PDF de una página';
    by('contour-mode').value=source.paths.length?'original':'automatic';
    changeView(source.paths.length?'print':'overlay');
    recompute();
    try {
      const {image,raster}=await thumbnail(source);
      if (version!==model.version) return;
      Object.assign(model,{thumb:image,raster});
    } catch {
      if (version!==model.version) return;
      model.thumbError=true;
    }
    recompute();
  } catch (error) {
    if (version!==model.version) return;
    by('filemeta').textContent='Elige otro archivo';
    note('file-status',error.message || 'No se pudo analizar el archivo.',true);
  }
}

function draw() {
  const plan = model.plan;
  if (!plan) { by('proof-marks').textContent = ''; return; }
  const panel = plan.panels[model.page];
  const maxWidth = Math.max(100,viewport.clientWidth - 52);
  const fitScale = Math.min(maxWidth/plan.roll,Math.max(100,viewport.clientHeight-60)/panel.length);
  const scale = fitScale * model.zoom;
  const width = plan.roll*scale, height = panel.length*scale;
  const ratio = Math.min(window.devicePixelRatio || 1,2,4096/Math.max(width,height),Math.sqrt(9000000/(width*height)));
  by('sheet').style.width=width+'px';
  canvas.style.width = width+'px';
  canvas.style.height = height+'px';
  canvas.width = Math.ceil(width*ratio);
  canvas.height = Math.ceil(height*ratio);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale*ratio,scale*ratio);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0,0,plan.roll,panel.length);
  ctx.lineWidth = .85/scale;

  if (model.mode !== 'cut') {
    const [left,bottom,right,top] = model.source.artwork;
    const [x0,y0,x1,y1] = plan.printBounds;
    const dx=(x0-plan.artwork[0])/PT,dy=(plan.artwork[3]-y1)/PT;
    for (const [x,y] of panel.positions) {
      if (model.thumb) {
        const sx = model.thumb.width/(right-left), sy = model.thumb.height/(top-bottom);
        ctx.drawImage(model.thumb,(x0-left)*sx,(top-y1)*sy,(x1-x0)*sx,(y1-y0)*sy,x+dx,y+dy,(x1-x0)/PT,(y1-y0)/PT);
      }
      else {
        ctx.fillStyle = '#eff4ef';
        ctx.fillRect(x,y,plan.width,plan.height);
        ctx.strokeStyle = '#9cafa1';
        ctx.strokeRect(x,y,plan.width,plan.height);
      }
    }
  }
  if (model.mode !== 'print') {
    const [left,,,top] = plan.artwork;
    ctx.strokeStyle = '#c21b72';
    for (const path of model.source.paths) {
      const vector = new Path2D();
      for (const [op, ...coords] of path) {
        const values = coords.map((value,index) => index%2 ? (top-value)/PT : (value-left)/PT);
        if (op === 'm') vector.moveTo(...values);
        if (op === 'l') vector.lineTo(...values);
        if (op === 'c') vector.bezierCurveTo(...values);
        if (op === 'h') vector.closePath();
      }
      for (const [x,y] of panel.positions) {
        ctx.save();
        ctx.translate(x,y);
        ctx.stroke(vector);
        ctx.restore();
      }
    }
  }
  ctx.fillStyle = '#000';
  for (const [x,y] of panel.marks) ctx.fillRect(x,y,3,3);
  by('sheet-width').textContent = fmt(plan.roll)+' mm';
  by('proof-marks').textContent = panel.marks.length+' marcas · '+fmt(panel.length)+' mm de largo';
  note('preview-message', model.mode !== 'cut' && !model.thumb
    ? model.thumbError ? 'No se pudo dibujar la gráfica en la vista previa.' : 'Dibujando la gráfica…' : '');
  by('zoom-value').value=fmt(model.zoom*100)+' %';
  by('zoom-in').disabled=model.zoom>=8;
  by('zoom-out').disabled=model.zoom<=.5;
  model.displayScale=scale;
  if (model.zoomAnchor) {
    const {x,y,anchorX,anchorY}=model.zoomAnchor;
    const rect=canvas.getBoundingClientRect(), frame=viewport.getBoundingClientRect();
    viewport.scrollLeft+=rect.left-frame.left+x*scale-anchorX;
    viewport.scrollTop+=rect.top-frame.top+y*scale-anchorY;
    model.zoomAnchor=null;
  }
}

async function prepareExports() {
  if (!model.plan || model.busy) return;
  const {source,plan,name}=model;
  model.busy=true;
  refreshButtons();
  note('export-status','Preparando los PDF…');
  await new Promise((resolve)=>setTimeout(resolve,0));
  try {
    if (plan!==model.plan) return;
    const files=await build(source,plan);
    if (plan!==model.plan) return;
    clearExports();
    model.urls=files.map((file)=>URL.createObjectURL(new Blob([file],{type:'application/pdf'})));
    const base=name.replace(/\.(pdf|jpe?g|png)$/i,'');
    ['print','cut'].forEach((key,index)=>{
      by(key).href=model.urls[index];
      by(key).download=base+(index?'_corte.pdf':'_impresion.pdf');
      by('open-'+key).href=model.urls[index];
    });
    note('export-status','PDF de impresión y corte preparados.');
  } catch (error) {
    if (plan===model.plan) note('export-status','Error al generar los PDF. '+error.message,true);
  } finally {
    if (plan===model.plan) {
      model.busy=false;
      refreshButtons();
    }
  }
}

async function photoBytes(file) {
  const bytes=await file.arrayBuffer();
  const signature=new Uint8Array(bytes,0,Math.min(bytes.byteLength,4));
  const jpeg=signature[0]===255 && signature[1]===216;
  const png=signature[0]===137 && signature[1]===80 && signature[2]===78 && signature[3]===71;
  if (jpeg || png) return bytes;

  const url=URL.createObjectURL(file);
  try {
    const image=new Image();
    image.src=url;
    await image.decode();
    const canvas=document.createElement('canvas');
    canvas.width=image.naturalWidth;
    canvas.height=image.naturalHeight;
    const context=canvas.getContext('2d');
    if (!context) throw new Error('No hay contexto para la imagen');
    context.drawImage(image,0,0);
    const pngBlob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    if (!pngBlob) throw new Error('No se pudo convertir la imagen');
    return await pngBlob.arrayBuffer();
  } catch {
    throw new Error('Este navegador no puede abrir el formato de la foto. Prueba a exportarla como JPG o PNG.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadFile(file) { if (file) load(file.name, () => file.arrayBuffer()); }
by('photo')?.addEventListener('change', (event) => {
  const input=event.currentTarget;
  const file=input.files[0];
  if (file) load(file.name, () => photoBytes(file));
  input.value='';
});
fileField.addEventListener('change', () => { loadFile(fileField.files[0]); fileField.value = ''; });
drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('active'); });
drop.addEventListener('dragleave', () => drop.classList.remove('active'));
drop.addEventListener('drop', (event) => {
  event.preventDefault();
  drop.classList.remove('active');
  loadFile(event.dataTransfer.files[0]);
});
by('demo').addEventListener('click', () => load('Silueta_de_ejemplo.pdf',() => sample(true)));
by('settings').addEventListener('submit', (event) => event.preventDefault());
by('settings').addEventListener('input', (event) => {
  if (event.target.id==='size-mode' && model.original) {
    const mode=event.target.value;
    const previous=model.sized && artworkSize(model.sized.source);
    const input=by('size-value');
    if (mode==='percent') {
      if (model.original.image && previous && !by('reference-width').value) {
        by('reference-width').value=Number(previous.width.toFixed(5));
      }
      const reference=model.original.image ? by('reference-width').valueAsNumber : artworkSize(model.original).width;
      input.value=previous && reference ? Number((previous.width/reference*100).toFixed(5)) : 100;
    } else {
      const dimensions=previous ?? (!model.original.image && artworkSize(model.original));
      input.value=dimensions ? Number(dimensions[mode].toFixed(5)) : '';
    }
  }
  if (event.target.id==='offset' || event.target.id==='contour-mode') changeView('overlay');
  recompute();
});
by('panel').addEventListener('change', () => { model.page = Number(by('panel').value); scheduleDraw(); });
by('prepare').addEventListener('click',prepareExports);
by('zoom-out').addEventListener('click',()=>updateZoom(model.zoom/Math.sqrt(2)));
by('zoom-in').addEventListener('click',()=>updateZoom(model.zoom*Math.sqrt(2)));
by('zoom-fit').addEventListener('click',()=>{
  model.zoom=1;
  model.zoomAnchor=null;
  viewport.scrollTo(0,0);
  scheduleDraw();
});
viewport.addEventListener('wheel',(event)=>{
  if (!model.plan || !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  const rect=viewport.getBoundingClientRect();
  updateZoom(model.zoom*Math.exp(-event.deltaY*.006),event.clientX-rect.left,event.clientY-rect.top);
},{passive:false});
for (const mode of ['print','overlay','cut']) {
  by('show-'+mode).addEventListener('click', () => changeView(mode));
}
new ResizeObserver(scheduleDraw).observe(viewport);
