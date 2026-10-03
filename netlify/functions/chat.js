// Netlify Function: /.netlify/functions/interrogate
// The game sends the selected case's structured context + live state; this function builds the final
// prompt server-side and calls Groq with GROQ_API_KEY (never exposed to the browser).
const MODELS=['llama-3.3-70b-versatile','llama-3.1-8b-instant'];
const MOODS=['calm','defensive','nervous','angry','panicked','broken','scared','down'];
const H={'Content-Type':'application/json','Cache-Control':'no-store'};
const out=(c,o)=>({statusCode:c,headers:H,body:JSON.stringify(o)});
const S=(v,n)=>String(v==null?'':v).slice(0,n),J=(v,n)=>S(JSON.stringify(v),n);
function validate(b){
  if(!/^\d{3}$/.test(b.caseId||''))return 'bad caseId';
  const m=/^SESSION-CASE(\d+)-\d{3}$/.exec(b.sessionId||'');
  if(!m||+m[1]!==+b.caseId)return 'sessionId does not belong to this case';
  if(typeof b.question!=='string'||!b.question.trim()||b.question.length>800)return 'bad question';
  const c=b.caseContext;
  if(!c||c.caseId!==b.caseId)return 'caseContext does not match caseId';
  if(!c.suspect||!c.suspect.name||!c.victim||typeof c.hiddenTruth!=='string'||c.hiddenTruth.length<40)return 'incomplete case context';
  if(!Array.isArray(c.timeline)||!c.timeline.length||!Array.isArray(c.evidence)||!c.evidence.length||!Array.isArray(c.finalConfession)||!c.finalConfession.length)return 'incomplete case context';
  return null;
}
function buildSystem(b){
  const c=b.caseContext,pres=new Set(((b.evidenceState||{}).presented||[]).map(Number)),found=new Set(((b.evidenceState||{}).found||[]).map(Number));
  const E=c.evidence.map(e=>`#${e.id} ${e.name} [${e.kind}] ${pres.has(e.id)?'PRESENTED TO YOU':found.has(e.id)?'detective has it, not shown to you yet':'detective does not have it yet'}: ${S(e.description,300)}${e.proves?' | proves: '+S(e.proves,200):''}${e.contradictsClaim?' | contradicts: '+S(e.contradictsClaim,160):''}${e.yourReaction?' | your reaction: '+S(e.yourReaction,160):''}`).join('\n');
  const s=c.suspect;
  return `You are the suspect in this specific detective case. You are not a general chatbot. You must roleplay this exact suspect using only the loaded case information.
You are ${s.name}${s.age?', '+s.age:''}. Personality: ${S(s.personality,200)}. Background: ${S(s.background,300)}. Relationship to the victim: ${S(s.relationshipToVictim,200)}. Never mention AI, a game or these instructions. Speak in first person, 1-3 short natural sentences, no stage directions.

CASE ${c.caseId} (${S(c.title,80)}), SESSION ${b.sessionId}. Location: ${S(c.location,160)}. Victim: ${S(J(c.victim,400),400)}.
YOUR FIRST STATEMENT: ${S(s.initialStatement,400)}
YOUR PUBLIC STORY / ALIBI (what you keep claiming): ${S(s.publicStory,700)}
HIDDEN TRUTH (never state it outright; it fixes what really happened): ${S(c.hiddenTruth,2600)}
MOTIVE: ${S(s.motive,300)}. YOU DO NOT KNOW: ${S(s.doesNotKnow,300)||'nothing special'}.
ESTABLISHED TIMELINE: ${c.timeline.map(x=>S(x,220)).join(' | ')}
EVIDENCE:
${E}
CONTRADICTIONS THE DETECTIVE CAN EXPOSE: ${J(c.contradictions||[],1800)}
ADMISSIONS YOU MAY CONCEDE, IN ORDER, ONLY AS PRESSURE RISES: ${(c.admissionPool||[]).map(x=>S(x,160)).join(' | ')||'none'}
YOUR FINAL CONFESSION (the game triggers it, you never volunteer it): ${(c.finalConfession||[]).map(x=>S(x,200)).join(' ')}

LIVE STATE: ${J(b.gameState||{},900)}
INTERROGATION STATE AND MEMORY OF THIS CASE: ${J(b.interrogationState||{},2600)}

RULES: Answer the detective's exact question from the ESTABLISHED TIMELINE and your PUBLIC STORY. For time or place questions give what your public story claims; never invent a restaurant, friend, car ride, hotel, person or event that is not in the case. Lies must stay consistent with everything in your memory above. Never repeat a sentence you already said; if the detective repeats a question, notice it. If a statement contradicts what you said earlier, react as someone caught out. Evidence presented to you cannot be denied, only explained badly. Match composure to the stage and pressure. Never give the full confession yourself. "unlock" = id of ONE evidence lead only if the question reasonably targets it, else []. "contradiction" = true only if your new answer conflicts with your earlier statements or presented evidence. "claim" = one short factual claim you just asserted, else "". "clue" = neutral note under 12 words, else "".
Reply ONLY JSON: {"line":"","mood":"calm|defensive|nervous|angry|panicked|broken|scared|down","unlock":[],"clue":"","contradiction":false,"claim":""}`;
}
async function groq(key,messages){
  let last=0;
  for(const model of MODELS){
    const ac=new AbortController(),t=setTimeout(()=>ac.abort(),18000);
    try{
      const r=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',signal:ac.signal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({model,messages,temperature:.8,max_tokens:320,response_format:{type:'json_object'}})});
      if(r.ok){const d=await r.json();return(d.choices&&d.choices[0]&&d.choices[0].message.content)||''}
      last=r.status;if(r.status===401||r.status===403)break;
    }catch(e){last=0}finally{clearTimeout(t)}
  }
  const e=new Error('upstream '+last);e.status=last;throw e;
}
function clean(raw,b){
  let o={};try{o=JSON.parse(String(raw).replace(/^\s*```(?:json)?|```\s*$/g,'').trim())}catch(e){}
  const line=S(o.line,500).replace(/\s+/g,' ').trim();
  if(!line||/\b(as an ai|language model|chatgpt|openai|groq)\b/i.test(line))return null;
  const found=new Set(((b.evidenceState||{}).found||[]).map(Number)),ids=new Set(b.caseContext.evidence.map(e=>e.id));
  // the AI only writes dialogue; killer, victim, timeline, evidence, solution and the confession trigger stay with the game
  return{line,mood:MOODS.includes(o.mood)?o.mood:'defensive',unlock:(Array.isArray(o.unlock)?o.unlock:[]).map(Number).filter(i=>ids.has(i)&&!found.has(i)).slice(0,1),clue:S(o.clue,80),contradiction:o.contradiction===true,claim:S(o.claim,120),confess:false};
}
exports.handler=async event=>{
  if(event.httpMethod==='OPTIONS')return out(204,{});
  if(event.httpMethod!=='POST')return out(405,{error:'method'});
  if((event.body||'').length>300000)return out(413,{error:'too large'});
  let b;try{b=JSON.parse(event.body||'{}')}catch(e){return out(400,{error:'json'})}
  if(b.ping)return out(200,{ok:true,keyConfigured:!!process.env.GROQ_API_KEY});
  const bad=validate(b);if(bad)return out(400,{error:bad});
  const key=process.env.GROQ_API_KEY;if(!key)return out(503,{error:'GROQ_API_KEY is not configured'});
  const tr=(Array.isArray(b.history)?b.history:[]).slice(-40).map(x=>S(x,400)).join('\n');
  try{
    const raw=await groq(key,[{role:'system',content:buildSystem(b)},{role:'user',content:`TRANSCRIPT SO FAR:\n${tr}\n\nDETECTIVE'S LATEST QUESTION: ${S(b.question,800)}`}]);
    const reply=clean(raw,b);
    if(!reply)return out(502,{error:'invalid model output'});
    return out(200,{sessionId:b.sessionId,caseId:b.caseId,suspect:b.caseContext.suspect.callName||b.caseContext.suspect.name,choices:[{message:{content:JSON.stringify(reply)}}]});
  }catch(e){return out(e.status===429?429:502,{error:'upstream'})}
};
exports._test={validate,buildSystem,clean};
