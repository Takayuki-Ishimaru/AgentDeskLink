import { createServer } from 'node:http';
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><title>AgentDeskLink test application</title><style>body{font:18px system-ui;max-width:720px;margin:64px auto;padding:20px;color:#18342b;background:#f4f7f2}input,select,button{font:inherit;padding:10px;margin:8px}button{background:#225b43;color:white;border:0;border-radius:8px}label{display:block}h1{font-size:36px}</style><h1>AgentDeskLink test application</h1><p>This anonymous fixture supports semantic browser verification.</p><label>Search<input id="query" aria-label="Search"></label><button id="find" type="button">Find</button><p role="status" id="status">Ready</p><label><input id="option" type="checkbox">Option</label><label>Color<select id="color" aria-label="Color"><option>Red</option><option>Blue</option></select></label><label>Password (redaction fixture)<input type="password" value="CANARY_PASSWORD" aria-label="Password"></label><script>document.getElementById('find').onclick=()=>document.getElementById('status').textContent='Search complete';</script><h2>Visual gesture surface</h2><canvas id="board" width="600" height="180" style="width:600px;height:180px;touch-action:none;background:white"></canvas><p role="status" id="gesture-status">Ready for drag or touch swipe</p><script>
const board=document.getElementById('board'),ctx=board.getContext('2d');let pressed=false;
function draw(x,y){ctx.clearRect(0,0,600,180);ctx.fillStyle='#225b43';ctx.fillRect(x-20,y-20,40,40)}draw(40,40);
board.onpointerdown=e=>{pressed=true;board.setPointerCapture(e.pointerId)};
board.onpointermove=e=>{if(pressed){const r=board.getBoundingClientRect();draw(e.clientX-r.left,e.clientY-r.top)}};
board.onpointerup=e=>{pressed=false;document.getElementById('gesture-status').textContent='Gesture complete: '+e.pointerType};
board.onpointercancel=()=>{pressed=false};
</script></html>`;
const server = createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end();
    return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(page);
});
server.listen(4173, '127.0.0.1', () => console.log('Demo: http://127.0.0.1:4173'));
