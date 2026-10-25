import {readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join} from 'node:path';

// A small Windows VM cannot keep several Chromium-heavy test files within the
// same action deadlines. Keep the assertions and deadlines identical while
// avoiding that artificial contention. Other hosts retain four workers.
const files=(await readdir('dist/tests')).filter(name=>name.endsWith('.test.js')).sort().map(name=>join('dist/tests',name));
if(!files.length)throw new Error('No compiled tests found');
const child=spawn(process.execPath,['--test',`--test-concurrency=${process.platform==='win32'?1:4}`,'--test-timeout=30000','--test-force-exit',...files],{stdio:'inherit',windowsHide:true});
child.on('error',error=>{console.error(error);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
