const P = globalThis.PDFLib;
const { PDFName, PDFDict, PDFArray, PDFNumber, PDFRawStream, PDFObjectCopier } = P;
export const PT = 72 / 25.4;
const name = PDFName.of;
const readName = (value) => value instanceof PDFName ? value.decodeText() : '';
const isCut = (value) => value.replace(/[\s_-]/g, '').toLowerCase() === 'cutcontour';
const identity = [1, 0, 0, 1, 0, 0];
const drawing = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const strokes = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);
const fills = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const processColors = new Set(['G', 'RG', 'K', 'g', 'rg', 'k']);
const closePaint = new Set(['s', 'b', 'b*']);
const line = (value) => Number(value.toFixed(6)).toString();
const encode = (content) => Uint8Array.from(content, (char) => char.charCodeAt(0));
const ascii = (bytes) => {
  let output = '';
  for (let i = 0; i < bytes.length; i += 32768) {
    output += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return output;
};
const bad = (message) => { throw new Error(message); };

function point(matrix, x, y) {
  const [a, b, c, d, e, f] = matrix;
  return [a * x + c * y + e, b * x + d * y + f];
}

function multiply(a, b) {
  return [...point(a, b[0], b[1]).map((v, i) => v - a[i + 4]),
    ...point(a, b[2], b[3]).map((v, i) => v - a[i + 4]),
    ...point(a, b[4], b[5])];
}

function* operations(content) {
  const lexer = /%[^\r\n]*|[\x00\t\n\f\r ]+|<<|>>|[\[\]()]|<[^>]*>|\/[^\x00\t\n\f\r ()<>\[\]{}\/%]*|[^\x00\t\n\f\r ()<>\[\]{}\/%]+|./gy;
  let depth = 0;
  let operands = [];
  let start = 0;
  for (let match; (match = lexer.exec(content));) {
    const token = match[0];
    if (/^[%\x00\t\n\f\r ]/.test(token)) continue;
    if (token === '(') {
      let level = 1;
      let index = lexer.lastIndex;
      while (index < content.length && level) {
        const char = content[index++];
        if (char === '\\') index++;
        if (char === '(') level++;
        if (char === ')') level--;
      }
      if (level) bad('El PDF contiene una cadena incompleta.');
      lexer.lastIndex = index;
    }
    if (token === '[' || token === '<<') depth++;
    if (token === ']' || token === '>>') depth--;
    if (depth || /^[\/([<]/.test(token) || /^(?:\]|>>|true|false|null|[+-]?(?:\d+\.?\d*|\.\d+))$/.test(token)) {
      operands.push(token);
      continue;
    }
    if (token === 'BI') bad('Este PDF usa imágenes en línea. Reexpórtalo con las imágenes como objetos y conserva la tinta plana CutContour.');
    yield { op: token, operands, start, end: lexer.lastIndex };
    start = lexer.lastIndex;
    operands = [];
  }
}

function inspectPath(path, op, args, matrix) {
  const transform = (i) => point(matrix, Number(args[i]), Number(args[i + 1]));
  if (op === 're') {
    const [x, y, w, h] = args.map(Number);
    path.push(['m', ...point(matrix, x, y)], ['l', ...point(matrix, x+w, y)],
      ['l', ...point(matrix, x+w, y+h)], ['l', ...point(matrix, x, y+h)], ['h']);
  } else if (op === 'h') {
    path.push(['h']);
  } else if (op === 'c') {
    path.push(['c', ...transform(0), ...transform(2), ...transform(4)]);
  } else if (op === 'y') {
    const end = transform(2);
    path.push(['c', ...transform(0), ...end, ...end]);
  } else if (op === 'v') {
    let previous = path.at(-1);
    if (previous?.[0] === 'h') previous = path.findLast((segment) => segment[0] === 'm');
    if (!previous) bad('El PDF contiene un trazado sin punto inicial.');
    path.push(['c', ...previous.slice(-2), ...transform(0), ...transform(2)]);
  } else {
    path.push([op, ...transform(0)]);
  }
}

function coordinates(paths) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const include = (axis, value) => {
    if (!Number.isFinite(value)) bad('El PDF contiene coordenadas de corte inválidas.');
    bounds[axis] = Math.min(bounds[axis], value);
    bounds[axis + 2] = Math.max(bounds[axis + 2], value);
  };
  for (const path of paths) {
    let current, start;
    for (const [op, ...values] of path) {
      if (op === 'h') { current = start; continue; }
      const end = values.slice(-2);
      for (let axis = 0; axis < 2; axis++) {
        include(axis, end[axis]);
        if (op !== 'c' || !current) continue;
        const [a, b, c, d] = [current[axis], values[axis], values[axis+2], end[axis]];
        const A = -a + 3*b - 3*c + d, B = 2*(a - 2*b + c), C = b - a;
        const discriminant = B*B - 4*A*C;
        const roots = Math.abs(A) < 1e-10 ? [-C/B] : discriminant < 0 ? [] :
          [(-B + Math.sqrt(discriminant))/(2*A), (-B - Math.sqrt(discriminant))/(2*A)];
        for (const t of roots.filter((value) => value > 0 && value < 1)) {
          const s = 1 - t;
          include(axis, s*s*s*a + 3*s*s*t*b + 3*s*t*t*c + t*t*t*d);
        }
      }
      current = end;
      if (op === 'm') start = end;
    }
  }
  return bounds;
}

function boxContains(outer, inner) {
  return outer[0] <= inner[0] + .01 && outer[1] <= inner[1] + .01 &&
    outer[2] >= inner[2] - .01 && outer[3] >= inner[3] - .01;
}

function formClip(matrix, box) {
  const [a, b, c, d, e, f] = matrix;
  const determinant = a*d - b*c;
  if (!determinant || !box) return null;
  const inverse = [d, -b, -c, a, c*f-d*e, b*e-a*f].map((value) => value/determinant);
  return {box, inverse};
}

function insideClip(clip, path, bounds) {
  if (!clip) return false;
  if (!clip.inverse) return boxContains(clip, bounds);
  const transformed = path.map(([op,...values]) => {
    const coords = [];
    for (let i = 0; i < values.length; i += 2) coords.push(...point(clip.inverse,values[i],values[i+1]));
    return [op,...coords];
  });
  return boxContains(clip.box,coordinates([transformed]));
}

function clipPath(path) {
  const bounds = coordinates([path]);
  const simple = path.length === 5 && path[0][0] === 'm' && path[4][0] === 'h' &&
    path.slice(1, 4).every(([op]) => op === 'l') &&
    path.slice(0, 4).every(([, x, y]) =>
      (x === bounds[0] || x === bounds[2]) && (y === bounds[1] || y === bounds[3]));
  return simple ? bounds : null;
}

function decodeName(token) {
  return token.slice(1).replace(/#([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function cutChannels(space) {
  if (!(space instanceof PDFArray)) return [];
  const kind=readName(space.lookup(0));
  if (kind==='Separation' && isCut(readName(space.lookup(1)))) return [0];
  if (kind==='DeviceN') {
    const channels=space.lookup(1);
    if (channels instanceof PDFArray) {
      return channels.asArray().flatMap((item,index)=>isCut(readName(item)) ? [index] : []);
    }
  }
  return [];
}

function hasCutInk(resources,seen=new Set()) {
  if (seen.has(resources)) return false;
  seen.add(resources);
  const colors=resources.lookupMaybe(name('ColorSpace'),PDFDict);
  if (colors?.keys().some((key)=>cutChannels(colors.lookup(key)).length)) return true;
  const xobjects=resources.lookupMaybe(name('XObject'),PDFDict);
  return xobjects?.keys().some((key)=>{
    const object=xobjects.lookup(key);
    if (!(object instanceof PDFRawStream) || readName(object.dict.get(name('Subtype')))!=='Form') return false;
    const inner=object.dict.lookupMaybe(name('Resources'),PDFDict);
    return inner && hasCutInk(inner,seen);
  }) ?? false;
}

function splitStream(content, resources, context, initial, paths, depth = 0) {
  if (depth > 24) bad('El PDF contiene demasiados objetos anidados.');
  const cleaned = resources.clone();
  const xobjects = resources.lookupMaybe(name('XObject'), PDFDict);
  const newObjects = context.obj({});
  if (xobjects) cleaned.set(name('XObject'), newObjects);
  const colors = resources.lookupMaybe(name('ColorSpace'), PDFDict);
  const inks = new Map();
  if (colors) {
    const printColors = colors.clone();
    for (const key of colors.keys()) {
      const indexes=cutChannels(colors.lookup(key));
      if (indexes.length) {
        inks.set(readName(key),indexes);
        printColors.delete(key);
      }
    }
    cleaned.set(name('ColorSpace'), printColors);
  }

  let state = { ...initial };
  const stack = [];
  let path = [], clip = false, output = '', last = 0;
  const replace = (start, end, value) => {
    output += content.slice(last, start) + '\n' + value + '\n';
    last = end;
  };

  for (const {op, operands, start, end} of operations(content)) {
    if (op === 'q') stack.push({ ...state });
    if (op === 'Q') state = stack.pop() ?? state;
    if (op === 'cm') state.matrix = multiply(state.matrix, operands.map(Number));
    if (op === 'CS' || op === 'cs') {
      const cutting = inks.get(decodeName(operands[0] ?? ''));
      const channel = op === 'CS' ? 'stroke' : 'fill';
      state[channel] = cutting;
      state[channel+'Active'] = !!cutting;
      if (cutting) replace(start, end, '/DeviceCMYK ' + op);
    }
    if (processColors.has(op)) state[op === op.toUpperCase() ? 'stroke' : 'fill'] = null;
    if (['SCN', 'SC', 'scn', 'sc'].includes(op)) {
      const isStroke = op === op.toUpperCase();
      const channel = isStroke ? 'stroke' : 'fill';
      const indexes = state[channel];
      if (indexes) {
        if (operands.some((value, index) => Number(value) !== 0 && !indexes.includes(index))) {
          bad('CutContour comparte un mismo trazo con otras tintas. En el original, aplica solo CutContour a la línea de corte.');
        }
        const active = indexes.some((index) => Number(operands[index]) > 0);
        state[channel+'Active'] = active;
        replace(start, end, (active ? '0 1 0 0 ' : '0 0 0 0 ') + (isStroke ? 'K' : 'k'));
      }
    }
    if (op === 'Tr') state.textMode = Number(operands[0]);
    if (drawing.has(op)) inspectPath(path, op, operands, state.matrix);
    if (op === 'W' || op === 'W*') clip = true;

    if (strokes.has(op) || fills.has(op) || op === 'n') {
      if (closePaint.has(op) && path.length) path.push(['h']);
      const currentClip = clip ? [...state.clips, clipPath(path)] : state.clips;
      if (fills.has(op) && state.fill && state.fillActive) bad('CutContour aparece como relleno. En el PDF de origen debe estar aplicado a un trazo vectorial.');
      if (strokes.has(op) && state.stroke && path.some(([type]) => type === 'l' || type === 'c')) {
        const bounds = coordinates([path]);
        if (currentClip.some((box) => !insideClip(box, path, bounds))) {
          bad('Un recorte afecta a CutContour. Exporta el trazado de corte fuera de la máscara.');
        }
        if (state.strokeActive) paths.push(path);
        const fill = op.endsWith('*') ? 'f*' : 'f';
        replace(start, end, fills.has(op) ? (closePaint.has(op) ? 'h ' : '') + fill : 'n');
      }
      state.clips = currentClip;
      clip = false;
      path = [];
    }

    if (op === 'Do') {
      const key = name(decodeName(operands[0] ?? ''));
      const entry = xobjects?.get(key);
      const object = context.lookup(entry);
      if (!(object instanceof PDFRawStream)) bad('El PDF contiene un objeto gráfico ilegible.');
      if (readName(object.dict.get(name('Subtype'))) !== 'Form') {
        newObjects.set(key, entry);
        continue;
      }
      const matrix = object.dict.lookupMaybe(name('Matrix'), PDFArray)?.asArray().map((item) => item.asNumber()) ?? identity;
      const formResources = object.dict.lookupMaybe(name('Resources'), PDFDict) ?? resources;
      const transform = multiply(state.matrix, matrix);
      const box = object.dict.lookupMaybe(name('BBox'), PDFArray)?.asArray().map((item) => item.asNumber());
      const clips = [...state.clips, formClip(transform, box)];
      const form = splitStream(ascii(P.decodePDFRawStream(object).decode()), formResources, context,
        { ...state, matrix: transform, clips }, paths, depth + 1);
      const dict = object.dict.clone();
      dict.delete(name('Filter'));
      dict.delete(name('DecodeParms'));
      dict.set(name('Resources'), form.resources);
      const ref = context.register(context.flateStream(encode(form.content), Object.fromEntries(
        dict.entries().filter(([key]) => readName(key) !== 'Length').map(([key, value]) => [readName(key), value]))));
      const newKey = name('PFForm_' + ref.objectNumber);
      newObjects.set(newKey, ref);
      replace(start, end, newKey.toString() + ' Do');
    }

    const textFill = [0, 2, 4, 6].includes(state.textMode) && state.fill;
    const textStroke = [1, 2, 5, 6].includes(state.textMode) && state.stroke;
    if (['Tj', 'TJ', '"', "'"].includes(op) && (textFill || textStroke)) {
      bad('CutContour debe ser un trazado vectorial independiente del texto y de los degradados.');
    }
  }
  return {content: output + content.slice(last), resources: cleaned};
}

export async function inspect(bytes, {allowNoCut=false}={}) {
  let doc;
  try { doc = await P.PDFDocument.load(bytes, {updateMetadata: false}); }
  catch { bad('No se pudo abrir este PDF. Comprueba que no esté protegido y vuelve a exportarlo.'); }
  if (doc.getPageCount() !== 1) bad('Sube un PDF de una sola página con una etiqueta.');
  const page = doc.getPage(0);
  const unit = page.node.lookupMaybe(name('UserUnit'), PDFNumber)?.asNumber() ?? 1;
  if (unit !== 1) bad('Reexporta la etiqueta en un PDF de tamaño normal, con unidades PDF estándar.');
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const orientations = {0: identity, 90: [0,-1,1,0,0,0], 180: [-1,0,0,-1,0,0], 270: [0,1,-1,0,0,0]};
  const matrix = orientations[rotation];
  if (!matrix) bad('El PDF tiene una rotación de página no compatible.');
  const {x, y, width, height} = page.getCropBox();
  const original = [x, y, x+width, y+height];
  if (!(width > 0 && height > 0)) bad('El PDF no tiene un tamaño de página válido.');
  const oriented = (box) => {
    const a = point(matrix, box[0], box[1]), b = point(matrix, box[2], box[3]);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  };
  const artwork = oriented(original);
  const streams = page.node.Contents();
  const parts = streams instanceof PDFArray ? streams.asArray().map((item) => doc.context.lookup(item)) : [streams];
  const content = parts.filter(Boolean).map((stream) => ascii(P.decodePDFRawStream(stream).decode())).join('\n');
  const paths = [];
  const resources=page.node.Resources() ?? doc.context.obj({});
  const result=hasCutInk(resources)
    ? splitStream(content,resources,doc.context,{matrix,stroke:null,fill:null,clips:[artwork],textMode:0},paths)
    : {content,resources};
  if (!paths.length && !allowNoCut) bad('No se encontró un trazo vectorial con tinta plana CutContour en el PDF.');
  if (paths.length && !boxContains(artwork,coordinates(paths))) bad('El contorno debe quedar dentro de la página del PDF.');
  const group = page.node.lookupMaybe(name('Group'), PDFDict);
  const dict = {Type:'XObject', Subtype:'Form', FormType:1, BBox:original, Matrix:matrix, Resources:result.resources};
  if (group) dict.Group = group;
  const printForm = doc.context.flateStream(encode(result.content), dict);
  const base={doc,printForm,artwork,matrix,paths};
  return paths.length ? withContour(base,paths) : base;
}

export async function openImage(bytes,format) {
  const doc=await P.PDFDocument.create();
  let image;
  try { image=await (format==='png' ? doc.embedPng(bytes) : doc.embedJpg(bytes)); }
  catch { bad('No se pudo abrir la imagen. Guarda una copia en JPG o PNG.'); }
  const width=100*PT,height=width*image.height/image.width;
  const page=doc.addPage([width,height]);
  page.drawImage(image,{x:0,y:0,width,height});
  return {...await inspect(await doc.save(),{allowNoCut:true}), image:true};
}

export function artworkSize({artwork}) {
  const [left,bottom,right,top]=artwork;
  return {width:(right-left)/PT,height:(top-bottom)/PT};
}

export function scaleSource(source,mode,value,referenceWidth) {
  if (!Number.isFinite(value)||value<=0) bad('Introduce una medida o un porcentaje mayor que cero.');
  const {width,height}=artworkSize(source);
  if (mode==='percent' && source.image && (!Number.isFinite(referenceWidth)||referenceWidth<=0||referenceWidth>5080)) {
    bad('Indica la anchura de referencia de la imagen al 100 %.');
  }
  const referenceScale=source.image ? referenceWidth/width : 1;
  const scale=mode==='percent' ? value/100*referenceScale : value/(mode==='height'?height:width);
  if (Math.max(width,height)*scale>5080) bad('El original escalado supera los 5.080 mm de ancho o alto.');
  if (scale===1) return source;
  const artwork=source.artwork.map((value)=>value*scale);
  const matrix=source.matrix.map((value)=>value*scale);
  const paths=source.paths.map((path)=>path.map(([op,...coords])=>[op,...coords.map((value)=>value*scale)]));
  const dict=source.printForm.dict.clone();
  dict.set(name('Matrix'),source.doc.context.obj(matrix));
  const printForm=PDFRawStream.of(dict,source.printForm.contents);
  return {...source,artwork,matrix,paths,printForm};
}

export function withContour(source,paths) {
  const trim=coordinates(paths);
  if (trim[2]<=trim[0] || trim[3]<=trim[1] || !trim.every(Number.isFinite)) bad('El contorno no tiene un ancho y alto válidos.');
  const cutContent='/CC CS 1 SCN 0.25 w\n'+paths.map((path)=>
    path.map(([op,...values])=>(values.length?values.map(line).join(' ')+' ':'')+op).join('\n')+'\nS').join('\n');
  return {...source,cutContent,paths,trim,sourceWidth:(trim[2]-trim[0])/PT,sourceHeight:(trim[3]-trim[1])/PT};
}

export function layout(source, settings) {
  const {roll, quantity, gap, margin, bleed} = settings;
  if (!Number.isFinite(roll) || roll <= 0 || roll > 5080) bad('Introduce un ancho de bobina entre 0 y 5.080 mm.');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50000) bad('Introduce una cantidad entera entre 1 y 50.000.');
  if (!Number.isFinite(gap) || gap < 0) bad('Introduce una separación de 0 mm o más.');
  if (!Number.isFinite(margin) || margin < 0) bad('Introduce un margen exterior de 0 mm o más.');

  if (bleed != null && (!Number.isFinite(bleed) || bleed < 0)) bad('Introduce un sangrado de 0 mm o más.');
  const printBounds=bleed == null ? source.artwork : source.artwork.map((edge,index)=>
    index<2 ? Math.max(edge,source.trim[index]-bleed*PT) : Math.min(edge,source.trim[index]+bleed*PT));
  const artwork=printBounds.map((edge,index)=>index<2 ? Math.min(edge,source.trim[index]) : Math.max(edge,source.trim[index]));
  const inset = margin + 8;
  const width = (artwork[2]-artwork[0])/PT;
  const height = (artwork[3]-artwork[1])/PT;
  const pitchX = source.sourceWidth + gap;
  const pitchY = source.sourceHeight + gap;
  const available = roll - 2*inset;
  if (available + 1e-7 < width) bad('La página de la etiqueta y las zonas de registro no caben en este ancho de bobina.');
  const potential = 1 + Math.floor((available - width + 1e-7) / pitchX);
  const columns = Math.min(quantity, potential);
  const rows = Math.ceil(quantity / columns);
  const required = Math.max(columns > 1 ? width-source.sourceWidth : 0, rows > 1 ? height-source.sourceHeight : 0);
  if (gap + 1e-7 < required) {
    bad('La página del PDF sobresale del contorno. Para que las gráficas no se solapen, usa al menos ' +
      (Math.ceil(required*100)/100).toLocaleString('es-ES') + ' mm de separación o ajusta el recorte del original.');
  }
  const rowsPerPage = Math.max(0, 1 + Math.floor((5000-2*inset-height + 1e-7)/pitchY));
  if (!rowsPerPage) bad('La etiqueta con los márgenes supera el largo máximo de un paño PDF.');
  const mountedWidth = width+(columns-1)*pitchX;
  const left = (roll-mountedWidth)/2;
  const right = left+mountedWidth;
  const panels = [];
  let remaining = quantity;
  while (remaining > 0) {
    const count = Math.min(remaining, rowsPerPage*columns);
    const rowCount = Math.ceil(count/columns);
    const length = height+(rowCount-1)*pitchY+2*inset;
    const positions = Array.from({length:count}, (_, index) => [
      left+(index%columns)*pitchX, inset+Math.floor(index/columns)*pitchY,
    ]);
    const start = margin, finish = length-margin-3;
    const levels = [start];
    if (length > 500+1e-7) {
      for (let y = start+400; y < finish-1e-7; y += 400) {
        levels.push(Math.min(y, finish-6));
      }
    }
    levels.push(finish);
    const marks = levels.flatMap((y) => [[left-8,y],[right+5,y]]);
    panels.push({length, positions, marks, rows:rowCount});
    remaining -= count;
  }
  return {roll, quantity, columns, rows, panels, artwork, printBounds, width, height, gap, total:panels.reduce((n,p) => n+p.length,0)};
}

function spot(context) {
  const fn = context.obj({FunctionType:2, Domain:[0,1], C0:[0,0,0,0], C1:[0,1,0,0], N:1});
  return context.obj(['Separation', 'CutContour', 'DeviceCMYK', fn]);
}

function addPanel(doc, ref, artwork, plan, panel) {
  const page = doc.addPage([plan.roll*PT,panel.length*PT]);
  page.setCropBox(0,0, plan.roll*PT,panel.length*PT);
  page.setTrimBox(0,0, plan.roll*PT,panel.length*PT);
  page.node.setXObject(name('Etiqueta'), ref);
  let mounted = '';
  for (const [x, y] of panel.positions) {
    const offsetX = x*PT-artwork[0];
    const offsetY = (panel.length-y-plan.height)*PT-artwork[1];
    mounted += 'q 1 0 0 1 '+line(offsetX)+' '+line(offsetY)+' cm /Etiqueta Do Q\n';
  }
  mounted += 'q 0 0 0 1 k\n';
  for (const [x, y] of panel.marks) {
    mounted += [x*PT,(panel.length-y-3)*PT,3*PT,3*PT].map(line).join(' ') + ' re f\n';
  }
  mounted += 'Q\n';
  page.node.addContentStream(doc.context.register(doc.context.flateStream(encode(mounted))));
}

async function printDocument(source,plan) {
  const print=await P.PDFDocument.create();
  print.setTitle('Plotter Fácil – Impresión');
  const copier=PDFObjectCopier.for(source.doc.context,print.context);
  const artwork=plan.artwork ?? source.artwork;
  const printBounds=plan.printBounds ?? source.artwork;
  const printForm=copier.copy(source.printForm);
  if (printBounds!==source.artwork) {
    const {inverse}=formClip(source.matrix,printBounds);
    const a=point(inverse,printBounds[0],printBounds[1]), b=point(inverse,printBounds[2],printBounds[3]);
    printForm.dict.set(name('BBox'),print.context.obj([
      Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1]),
    ]));
  }
  const printRef=print.context.register(printForm);
  for (const key of ['OutputIntents','OCProperties']) {
    const value=source.doc.catalog.get(name(key));
    if (value) print.catalog.set(name(key),copier.copy(value));
  }
  for (const panel of plan.panels) addPanel(print,printRef,artwork,plan,panel);
  return print.save({useObjectStreams:false});
}

export async function renderSource(source) {
  const width=(source.artwork[2]-source.artwork[0])/PT;
  const height=(source.artwork[3]-source.artwork[1])/PT;
  return printDocument(source,{roll:width,width,height,panels:[{length:height,positions:[[0,0]],marks:[]}]});
}

export async function build(source,plan) {
  const cut=await P.PDFDocument.create();
  cut.setTitle('Plotter Fácil – Corte');
  const artwork=plan.artwork ?? source.artwork;
  const cutBox=artwork.map((value,index)=>value+(index<2?-1:1));
  const cutForm=cut.context.flateStream(encode(source.cutContent),{Type:'XObject',Subtype:'Form',FormType:1,
    BBox:cutBox,Resources:cut.context.obj({ColorSpace:{CC:spot(cut.context)}})});
  const cutRef=cut.context.register(cutForm);
  for (const panel of plan.panels) addPanel(cut,cutRef,artwork,plan,panel);
  return Promise.all([printDocument(source,plan),cut.save({useObjectStreams:false})]);
}

export async function sample(automatic=false) {
  const doc = await P.PDFDocument.create();
  const page = doc.addPage([60*PT,40*PT]);
  const context = doc.context;
  const resources = page.node.normalizedEntries().Resources;
  resources.set(name('ColorSpace'),context.obj({CC:spot(context)}));
  const yellow=P.rgb(.96,.77,.42);
  if (automatic) {
    page.drawEllipse({x:30*PT,y:20*PT,xScale:24*PT,yScale:16*PT,color:yellow});
    page.drawCircle({x:15*PT,y:27*PT,size:9*PT,color:yellow});
    page.drawCircle({x:45*PT,y:27*PT,size:9*PT,color:yellow});
  } else page.drawRectangle({x:0,y:0,width:60*PT,height:40*PT,color:yellow});
  page.drawCircle({x:30*PT,y:22*PT,size:10*PT,color:P.rgb(.15,.24,.18)});
  const font = await doc.embedFont(P.StandardFonts.HelveticaBold);
  const title = 'TALLER GRÁFICO';
  page.drawText(title,{x:(60*PT-font.widthOfTextAtSize(title,10))/2,y:6*PT,size:10,font,color:P.rgb(.15,.24,.18)});
  page.drawText('P', {x:26.2*PT,y:17.9*PT,size:30,font,color:P.rgb(1,.94,.78)});
  const path = '/CC CS 1 SCN 0.25 w\n' + [1*PT,1*PT,58*PT,38*PT].map(line).join(' ') + ' re S\n';
  if (!automatic) page.node.addContentStream(context.register(context.flateStream(encode(path))));
  return doc.save();
}
