const fs=require('fs');const path=require('path');
const root=__dirname;
const files=[
 'api/index.js',
 'server/handlers/quiz/start.js',
 'server/handlers/quiz/next.js',
 'server/handlers/quiz/answer.js',
 'server/handlers/quiz/hint.js',
 'server/handlers/quiz/finish.js',
 'server/handlers/admin/config.js'
];
for(const f of files){const p=path.join(root,f);if(!fs.existsSync(p))throw new Error('Missing '+f);}
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
for(const needle of ['QUIZ_VERSION=\'11.0.0\'','id="nextBtn"','id="finishBtn"','id="saveConfig"','id="cfgQuestions"','id="cfgDaily"','id="adminDays"']){if(!html.includes(needle))throw new Error('Missing frontend marker: '+needle);}
console.log('HosBac Quiz V11 smoke checks: OK');
