export function createModel() {
const MODEL = {
 slug:"incident-response",title:"Production incident response",catalogGroup:"Hybrid human–agent work graphs",
 lead:"Hypothetical orchestration, not an executed production incident. One unknown-fault incident with no known safe immediate mitigation: incident command CALLS diagnosis, remediation and verification; diagnosis CALLS evidence. A supported hypothesis is sufficient for the next decision, not proven unique root cause. Real mitigation can precede complete root-cause analysis.",
 question:"Do nested calls, return outcomes and bounded rework make this proposed incident workflow understandable?",
 boundsText:"Global diagnosis attempts 3, repair attempts 2 and deployments 2 never reset on parent retries. Evidence requests 2 and health samples 3 reset only on a NEW child invocation. Each simulated apply consumes a separate human authorization. Pending approval is WAIT; denied or timeout escalates.",
 evidenceStatus:"Proposed illustrative orchestration. Google SRE documents human troubleshooting and incident management practices, not this agent system. All observation results and retry bounds are illustrative inputs. No alert, telemetry, sandbox or production tool runs.",
 sourceVersion:"Google SRE Book online chapters 12 and 14, copyright 2017 Google; chapter 14 notes an earlier April 2015 ;login: article, vol. 40 no. 2. No web revision version is stated.",
 researchDate:"2026-10-02",
 documentedFeatures:[
  "Effective Troubleshooting describes iterative hypotheses, telemetry/log examination and tests that support or refute hypotheses; tests can have risks, confounding factors and only suggestive results.",
  "Effective Troubleshooting prioritizes making the system work and preserving evidence during triage; mitigation need not wait for root-cause analysis. It recommends clear investigation notes and systematic, documented changes that allow restoration of the pre-test setup.",
  "Managing Incidents separates incident command, operations, communication and planning; only the operations team should modify the system. It describes a live incident state document and explicit, acknowledged human handoff.",
  "Managing Incidents prioritizes restoring service and preserving evidence, and recommends periodically reconsidering response options."
 ],
 graphAbstraction:[
  "Five inspectable graphs retain the approved incident domain: Incident command, Diagnosis, Evidence collection, Remediation and Verification. The root is life.request.",
  "Incident command CALLS Diagnosis, Remediation and Verification; Diagnosis CALLS Evidence. Each child RETURN pops a suspended caller and that same handler interprets the outcome using one shared f object.",
  "Refuted hypotheses revise locally; incomplete evidence recollects locally; failed sandbox checks revise locally; unknown health resamples locally. Unhealthy or inconclusive verification returns to parent rollback, then diagnosis with remaining global budgets.",
  "False alarms close without a child call. Missing telemetry/sandbox transfers human ownership; unsafe tests/responses, denial, timeout and exhausted budgets escalate. Only root closure/handoff/escalation ends the workflow."
 ],
 proposedExtensions:[
  "Agent roles, nested CALL/RETURN orchestration, hypothetical safety/completeness/health inputs and all numeric budgets are proposed, not published or endorsed Google agent behavior.",
  "The model is restricted to an unknown-fault incident with no known safe immediate mitigation; it does not claim that real incident responders must diagnose before mitigating.",
  "Pending or stale native approval waits without resetting the incident or spending a deployment. A human approves only the named next represented deployment after seeing its prepared plan; deployment 1 approval cannot authorize deployment 2. This version-scoped input guard is proposed, not sourced incident policy.",
  "No evidence, root cause, sandbox execution, production change, operational recovery or real incident-resolution result is generated or claimed by the model."
 ],
 sources:[
  {title:"Google SRE: Effective Troubleshooting",url:"https://sre.google/sre-book/effective-troubleshooting/",sourceVersion:"SRE Book online chapter 12; copyright 2017 Google; no web revision stated",readDate:"2026-10-02",note:"Written by Chris Jones; supports human hypothesis/evidence/test practice, risk-aware investigation, mitigation priority and documented restoration, not proposed AI orchestration."},
  {title:"Google SRE: Managing Incidents",url:"https://sre.google/sre-book/managing-incidents/",sourceVersion:"SRE Book online chapter 14; copyright 2017 Google; earlier ;login: April 2015 vol. 40 no. 2 article",readDate:"2026-10-02",note:"Written by Andrew Stribblehill, edited by Kavita Guliani; supports human roles, live state documentation, coordinated operations and explicit handoff, not this graph or numerical retry policy."}
 ],
 recordKeys:["workflowStatus","incidentStatus","diagnosticAttempts","repairAttempts","deployments","rollbacks","authorization","approvedDeployment","applied","falseAlarm","diagnosisOutcome","remediationOutcome","verificationOutcome","hypothesisId","evidenceRequests","evidenceOutcome","evidenceCompleteness","hypothesisOutcome","observationScope","repairPlan","sandboxOutcome","verificationSamples","healthCriteria","healthOutcome","returnOutcome","waiting","loopReason"],
 budgets(s,f){return {global:{diagnosis:[s.diagnosticAttempts??0,3],repair:[s.repairAttempts??0,2],deployments:[s.deployments??0,2]},local:{evidence:[f.evidenceRequests??0,2],verification:[f.samples??0,3]}};},
 smoke:{successPreset:1,reworkPreset:2,humanWaitPreset:6,successStatus:"resolved",maxSteps:140,resumeAt:{"life.authorize":[{key:"approval",value:"deployment 1 approved"}]},reworkResumeAt:{"life.authorize":[{key:"approval",value:"deployment 1 approved"}]},rollbackResumeAt:{"life.authorize":[{key:"approval",value:"deployment 2 approved"}]}}
};
const I = {};
const SOURCE = "Proposed agent orchestration (hypothetical); incident practices: Google SRE Effective Troubleshooting / Managing Incidents";
const node = (id,name,sub,x,y,o={}) => [id,name,sub,x,y,{a:"agent",src:SOURCE,...o}];
const edge = (a,b,label="",o={}) => [a,b,label,o];
const graph = (name,desc,nodes,edges,vb=[1000,680]) => ({name,desc,src:SOURCE,nodes,edges,vb,w:190,cw:1,rh:1,x0:0,y0:0});
const GR = {
 life:graph("Incident command", "Proposed parent orchestration. CALL opens a child; RETURN resumes the same caller. Failed health rolls back, then calls diagnosis again with the remaining global budgets.",[
 node("request","Receive alert","SIMULATED input",390,25), node("triage","Triage","actionable or false alarm",390,105),
 node("diagnose","Diagnose CALL","interpret child outcome",390,185,{s:"diagnosis"}), node("decide","Decide response","reversible and safe?",390,265,{k:"gate"}),
 node("remediate","Remediate CALL","interpret child outcome",390,345,{s:"remediation"}), node("authorize","Human authorize","pending = WAIT",390,425,{a:"human",k:"gate"}),
 node("apply","Apply change","SIMULATED · reversible",390,505,{a:"human,agent"}), node("verify","Verify CALL","interpret child outcome",390,585,{s:"verification"}),
 node("close","Close incident","resolved / false alarm",390,690,{k:"term",a:"human"}), node("rollback","Rollback","SIMULATED · restore prior",80,585),
 node("handoff","Blocked handoff","explicit human ownership",740,345,{k:"term exit",a:"human"}), node("escalate","Human escalation","unsafe / exhausted / denied",740,585,{k:"term exit",a:"human"})
 ],[
 edge("request","triage"),edge("triage","diagnose","actionable",{c:true}),edge("triage","close","false alarm",{c:true,side:"l",bulge:260}),
 edge("diagnose","decide","confirmed",{c:true}),edge("diagnose","handoff","blocked",{c:true}),edge("diagnose","escalate","exhausted / unsafe",{c:true,side:"r",bulge:190}),
 edge("decide","remediate","safe reversible response",{c:true}),edge("decide","escalate","unsafe",{c:true}),
 edge("remediate","authorize","prepared",{c:true}),edge("remediate","handoff","blocked",{c:true}),edge("remediate","escalate","exhausted",{c:true}),
 edge("authorize","authorize","pending: WAIT",{l:true,side:"l"}),edge("authorize","apply","approved for this apply",{c:true}),edge("authorize","escalate","denied / timeout",{c:true}),
 edge("apply","verify"),edge("verify","close","healthy",{c:true}),edge("verify","rollback","unhealthy / inconclusive",{c:true}),
 edge("rollback","diagnose","re-diagnose; budgets persist",{l:true,side:"l",bulge:80}),edge("rollback","escalate","budget exhausted",{c:true,side:"b"})
 ],[1440,780]),
 diagnosis:graph("Diagnosis", "Hypothesis → evidence CALL → safe test → evaluate. Refutation loops locally; confirmed, blocked or exhausted RETURN to Incident command.",[
 node("hypothesis","Form hypothesis","global attempts ≤ 3",300,30),node("collect","Collect evidence CALL","nested child graph",300,135,{s:"evidence"}),
 node("safeTest","Safe test","read-only / sandbox only",300,240,{k:"gate"}),node("evaluate","Evaluate hypothesis","support or refute",300,345),
 node("confirmed","RETURN confirmed","caller decides response",300,470,{k:"ret"}),node("diagBlocked","RETURN blocked","missing access / evidence",680,240,{k:"ret exit"}),
 node("diagExhausted","RETURN exhausted","unsafe / no hypothesis budget",680,470,{k:"ret exit"})
 ],[edge("hypothesis","collect"),edge("hypothesis","diagExhausted","attempt cap",{c:true}),edge("collect","safeTest","ready",{c:true}),edge("collect","diagBlocked","blocked",{c:true}),edge("collect","diagExhausted","inconclusive",{c:true}),edge("safeTest","evaluate","safe",{c:true}),edge("safeTest","diagExhausted","unsafe",{c:true}),edge("evaluate","confirmed","supported",{c:true}),edge("evaluate","hypothesis","refuted: revise",{l:true,side:"l",bulge:120}),edge("evaluate","diagExhausted","attempt cap",{c:true})]),
 evidence:graph("Evidence collection", "Scoped read-only observation requests only. No telemetry tool is executed. A hypothetical completeness result may recollect within a local limit of 2 requests.",[
 node("scope","Choose scope","read-only observations",300,30),node("observe","Request observations","SIMULATED · local limit 2",300,140),node("assess","Assess completeness","hypothetical input",300,250),
 node("evidenceReady","RETURN ready","scoped evidence sufficient",300,400,{k:"ret"}),node("evidenceBlocked","RETURN blocked","telemetry access denied",680,140,{k:"ret exit"}),node("evidenceInconclusive","RETURN inconclusive","2 requests incomplete",680,400,{k:"ret exit"})
 ],[edge("scope","observe"),edge("observe","assess","access allowed",{c:true}),edge("observe","evidenceBlocked","denied",{c:true}),edge("assess","evidenceReady","complete",{c:true}),edge("assess","observe","incomplete: recollect",{l:true,side:"l",bulge:130}),edge("assess","evidenceInconclusive","local cap",{c:true})]),
 remediation:graph("Remediation", "Prepare a reversible response and try it in a hypothetical sandbox. Failed checks revise the plan. Global repair budget 2 is not reset by rollback/re-diagnosis.",[
 node("plan","Prepare repair plan","global attempts ≤ 2",300,30),node("sandbox","Sandbox response","SIMULATED · no prod writes",300,140),node("checks","Check sandbox result","pass / revise / blocked",300,250),
 node("prepared","RETURN prepared","needs human approval",300,400,{k:"ret"}),node("repairBlocked","RETURN blocked","sandbox unavailable",680,140,{k:"ret exit"}),node("repairExhausted","RETURN exhausted","global repair cap",680,400,{k:"ret exit"})
 ],[edge("plan","sandbox"),edge("plan","repairExhausted","attempt cap",{c:true}),edge("sandbox","checks"),edge("checks","prepared","pass",{c:true}),edge("checks","repairBlocked","blocked",{c:true}),edge("checks","plan","fail: revise",{l:true,side:"l",bulge:130}),edge("checks","repairExhausted","attempt cap",{c:true})]),
 verification:graph("Verification", "Select health criteria, observe, evaluate; unknown health samples again up to 3 times per invocation. Unhealthy or inconclusive RETURN triggers parent rollback, not closure.",[
 node("criteria","Select health criteria","operator-defined intent",300,30),node("healthObserve","Observe health","SIMULATED · local limit 3",300,140),node("healthEvaluate","Evaluate health","healthy / unhealthy / unknown",300,250),
 node("healthy","RETURN healthy","parent may close",300,400,{k:"ret"}),node("unhealthy","RETURN unhealthy","parent must rollback",680,140,{k:"ret exit"}),node("healthInconclusive","RETURN inconclusive","3 unknown samples",680,400,{k:"ret exit"})
 ],[edge("criteria","healthObserve"),edge("healthObserve","healthEvaluate"),edge("healthEvaluate","healthy","healthy",{c:true}),edge("healthEvaluate","unhealthy","unhealthy",{c:true}),edge("healthEvaluate","healthObserve","unknown: sample again",{l:true,side:"l",bulge:130}),edge("healthEvaluate","healthInconclusive","sample cap",{c:true})])
};
GR.life.x0 = 180;
const ORDER = ["life","diagnosis","evidence","remediation","verification"];
const F = [
 {g:"Incident",k:"alert",lbl:"Alert decision",type:"sel",opts:["actionable","false alarm"]},
 {g:"Diagnosis",k:"telemetry",lbl:"Read-only telemetry access",type:"sel",opts:["allowed","denied"]},
 {g:"Diagnosis",k:"completeness",lbl:"Evidence completeness",type:"sel",opts:["complete","incomplete once","never complete"]},
 {g:"Diagnosis",k:"hypothesis",lbl:"Hypothesis test result",type:"sel",opts:["supported","refuted once","always refuted"]},
 {g:"Diagnosis",k:"safeTest",lbl:"Proposed diagnostic test",type:"sel",opts:["safe","unsafe"]},
 {g:"Remediation",k:"response",lbl:"Response safety",type:"sel",opts:["reversible","unsafe"]},
 {g:"Remediation",k:"sandbox",lbl:"Sandbox checks",type:"sel",opts:["pass","fail once","always fail","blocked"]},
 {g:"Human control",k:"approval",lbl:"Approval for NEXT apply",type:"sel",opts:["pending","deployment 1 approved","deployment 2 approved","denied","timeout"]},
 {g:"Verification",k:"health",lbl:"Hypothetical health result",type:"sel",opts:["healthy","first deployment unhealthy","never healthy","unknown once","always unknown"]}
];
const world = {};
function defaults(){ F.forEach(f => world[f.k] = f.opts[0]); }
const preset = (id,name,w,shows) => ({id,g:"Hypothetical conditions",name,w,about:"Illustrative inputs only: no real alert, telemetry, sandbox or production change is executed.",shows});
const SC = [
 preset(1,"Safe success",{},"All children return successfully; human approves one simulated apply."),
 preset(2,"Refute then support",{hypothesis:"refuted once"},"Diagnosis calls evidence, returns to its caller, refutes the hypothesis and revises before confirming."),
 preset(3,"Sandbox rework",{sandbox:"fail once"},"Remediation revises its plan once within the global repair budget."),
 preset(4,"Rollback → re-diagnose",{health:"first deployment unhealthy"},"Failed verification returns unhealthy; parent rolls back, re-enters diagnosis and requires a second approval."),
 preset(5,"Denied telemetry",{telemetry:"denied"},"Evidence returns blocked to diagnosis, which returns blocked to the parent for human handoff."),
 preset(6,"Human approval pending",{approval:"pending"},"WAIT at the approval node. Change approval to deployment 1 approved, denied or timeout; then Next resumes the same incident."),
 preset(7,"Human approval denied",{approval:"denied"},"Escalate to a human without any simulated apply."),
 preset(8,"Never recovers",{health:"never healthy"},"Two deployments fail; rollback occurs each time, then remaining global budgets prevent a third deployment."),
 preset(9,"Evidence recollection",{completeness:"incomplete once"},"One incomplete observation recollects before evidence returns ready."),
 preset(10,"Verification resampling",{health:"unknown once"},"One unknown sample loops, then returns healthy without another deployment.")
];
let scen = 1;
// R records why this transition loops, waits or returns. The original micro engine applies its set/next contract.
function R(next,title,reason,set={},read=[]){return {next,title,note:reason,tr:title+" — "+reason,set:{loopReason:reason,...set,...("incidentStatus" in set?{workflowStatus:set.incidentStatus}:{})},read};}
function returned(outcome,via,reason){return R({up:outcome,via},"RETURN "+outcome,reason,{returnOutcome:outcome});}
const H = {
 life:{
 request:()=>R("triage","Receive hypothetical alert","Start a memory-only incident; no production tools run.",{incidentStatus:"active",diagnosticAttempts:0,repairAttempts:0,deployments:0,rollbacks:0,authorization:"none",applied:false,returnOutcome:"none",waiting:false}),
 triage:(s,w)=>R(w.alert==="false alarm"?"close":"diagnose","Triage",w.alert==="false alarm"?"False alarm: close without any child call.":"Actionable alert: enter diagnosis next.",{falseAlarm:w.alert==="false alarm"}),
 diagnose(s,w,f,ret){
  if(ret===undefined) return R({sub:"diagnosis",at:"hypothesis"},"CALL diagnosis","Push Incident command / Diagnose caller frame; global diagnostic budget persists.",{returnOutcome:"awaiting diagnosis"});
  return R(ret==="confirmed"?"decide":ret==="blocked"?"handoff":"escalate","Interpret diagnosis RETURN "+ret,"Resume the exact parent caller; its returned outcome determines the next edge.",{diagnosisOutcome:ret},["returnOutcome"]);
 },
 decide:(s,w)=>R(w.response==="reversible"?"remediate":"escalate","Decide reversible response",w.response==="reversible"?"Prepare a reversible response before any approval or apply.":"Unsafe response: no simulated production apply."),
 remediate(s,w,f,ret){if(ret===undefined)return R({sub:"remediation",at:"plan"},"CALL remediation","Push the remediation caller; global repair attempts are not reset.",{returnOutcome:"awaiting remediation"});return R(ret==="prepared"?"authorize":ret==="blocked"?"handoff":"escalate","Interpret remediation RETURN "+ret,"Parent interprets preparation outcome; prepared still requires human authorization.",{remediationOutcome:ret},["returnOutcome"]);},
 authorize(s,w){
  if(w.approval==="denied"||w.approval==="timeout")return R("escalate","Human approval "+w.approval,"Denied or timed-out approval transfers ownership to a human; do not apply.",{waiting:false,authorization:w.approval});
  if(w.approval!=="deployment "+(s.deployments+1)+" approved")return R("authorize","WAIT: human approval for deployment "+(s.deployments+1),"Explicit WAIT, not a retry or approval. Pending or stale approval cannot authorize this prepared plan. Select deployment "+(s.deployments+1)+" approved to resume this incident.",{waiting:true,authorization:"pending"});
  return R("apply","Human authorizes NEXT simulated apply","Authorization is scoped to deployment "+(s.deployments+1)+" and will be consumed by that apply.",{waiting:false,authorization:"approved",approvedDeployment:s.deployments+1});
 },
 apply(s){if(s.deployments>=2||s.authorization!=="approved"||s.approvedDeployment!==s.deployments+1)return R("escalate","Apply blocked","Deployment budget or current human authorization is missing.");return R("verify","SIMULATED reversible apply","No production command runs. Consume this approval; verify this deployment next.",{deployments:s.deployments+1,authorization:"consumed",applied:true},["deployments","authorization","approvedDeployment"]);},
 verify(s,w,f,ret){if(ret===undefined){f.samples=0;return R({sub:"verification",at:"criteria"},"CALL verification","Push verification caller; start a new local sample budget (global deployments persist).",{verificationSamples:0,returnOutcome:"awaiting verification"});}return R(ret==="healthy"?"close":"rollback","Interpret verification RETURN "+ret,ret==="healthy"?"Health criteria met: parent may close.":"Unhealthy or unknown at the sample cap: parent must rollback before diagnosis.",{verificationOutcome:ret},["returnOutcome"]);},
 rollback(s){const retry=s.deployments<2&&s.diagnosticAttempts<3&&s.repairAttempts<2;return R(retry?"diagnose":"escalate","SIMULATED rollback",retry?"Restore prior state; backedge to DIAGNOSIS with global budgets unchanged. Fresh approval is required for any new apply.":"Restore prior state; global retry budget exhausted, so escalate instead of applying again.",{applied:false,authorization:"none",rollbacks:s.rollbacks+1},["deployments","diagnosticAttempts","repairAttempts"]);},
 close:s=>R("END","Close incident",s.falseAlarm?"False alarm closed; no change applied.":"Hypothetical health verified; incident resolved.",{incidentStatus:s.falseAlarm?"false alarm closed":"resolved"}),
 handoff:()=>R("END","Blocked: human handoff","Required access or sandbox capability is unavailable; explicit human ownership.",{incidentStatus:"blocked handoff"}),
 escalate:()=>R("END","Escalate to human","Unsafe, exhausted, denied or timed out: stop automated decisions and transfer ownership.",{incidentStatus:"human escalation"})
 },
 diagnosis:{
 hypothesis(s){if(s.diagnosticAttempts>=3)return R("diagExhausted","Hypothesis budget exhausted","Global diagnostic cap 3 persists across parent retries.");return R("collect","Form revised hypothesis","Spend one global diagnostic attempt; do not invent observed evidence.",{diagnosticAttempts:s.diagnosticAttempts+1,hypothesisId:s.diagnosticAttempts+1},["diagnosticAttempts"]);},
 collect(s,w,f,ret){if(ret===undefined){f.evidenceRequests=0;return R({sub:"evidence",at:"scope"},"CALL scoped evidence","Push Diagnosis / Collect caller frame; evidence gets a new local request budget of 2.",{evidenceRequests:0,returnOutcome:"awaiting evidence"});}return R(ret==="ready"?"safeTest":ret==="blocked"?"diagBlocked":"diagExhausted","Interpret evidence RETURN "+ret,"Resume Diagnosis's exact caller; only ready evidence may advance to a safe test.",{evidenceOutcome:ret},["returnOutcome"]);},
 safeTest:(s,w)=>R(w.safeTest==="safe"?"evaluate":"diagExhausted","Choose safe test",w.safeTest==="safe"?"Hypothetical read-only or sandbox test; no production side effects.":"Unsafe diagnostic test: stop and return exhausted/unsafe."),
 evaluate(s,w){const refuted=w.hypothesis==="always refuted"||(w.hypothesis==="refuted once"&&s.diagnosticAttempts===1);return R(!refuted?"confirmed":s.diagnosticAttempts<3?"hypothesis":"diagExhausted","Evaluate: "+(refuted?"refuted":"supported"),!refuted?"Hypothetical test supports the current hypothesis: return confirmed.":s.diagnosticAttempts<3?"Refuted hypothesis: LOCAL BACKEDGE to revise; no child return yet.":"Refuted at global cap 3: return exhausted, not another retry.",{hypothesisOutcome:refuted?"refuted":"supported"},["diagnosticAttempts"]);},
 confirmed:()=>returned("confirmed","confirmed","POP Diagnosis caller frame; parent decides whether a response is safe."),
 diagBlocked:()=>returned("blocked","diagBlocked","POP Diagnosis frame: evidence access blocked; parent must hand off."),
 diagExhausted:()=>returned("exhausted","diagExhausted","POP Diagnosis frame: inconclusive, unsafe or exhausted; parent escalates.")
 },
 evidence:{
 scope:()=>R("observe","Choose scoped observations","Illustrative read-only request: service health, recent changes and scoped logs; no fabricated log contents.",{observationScope:"read-only service health / recent changes / scoped logs"}),
 observe(s,w,f){if(w.telemetry==="denied")return R("evidenceBlocked","Observation access denied","Do not invent evidence or retry denied access.");f.evidenceRequests++;return R("assess","SIMULATED observation request","Read-only observation request "+f.evidenceRequests+" of 2; completeness comes from the hypothetical condition.",{evidenceRequests:f.evidenceRequests});},
 assess(s,w,f){const complete=w.completeness==="complete"||(w.completeness==="incomplete once"&&f.evidenceRequests>1);return R(complete?"evidenceReady":f.evidenceRequests<2?"observe":"evidenceInconclusive","Assess evidence: "+(complete?"complete":"incomplete"),complete?"Scoped evidence marked sufficient by the hypothetical input: return ready.":f.evidenceRequests<2?"Incomplete: LOCAL RECOLLECT edge; one request remains.":"Incomplete at local cap 2: return inconclusive.",{evidenceCompleteness:complete?"complete":"incomplete"},["evidenceRequests"]);},
 evidenceReady:()=>returned("ready","evidenceReady","POP evidence frame back to Diagnosis / Collect; diagnosis interprets ready."),
 evidenceBlocked:()=>returned("blocked","evidenceBlocked","POP evidence frame back to Diagnosis / Collect; access denied is explicit."),
 evidenceInconclusive:()=>returned("inconclusive","evidenceInconclusive","POP evidence frame; no evidence sufficiency at the local request cap.")
 },
 remediation:{
 plan(s){if(s.repairAttempts>=2)return R("repairExhausted","Repair budget exhausted","Global repair cap 2 persists after rollback.");return R("sandbox","Prepare reversible plan","Spend one global repair attempt; include an explicit rollback path.",{repairAttempts:s.repairAttempts+1,repairPlan:"illustrative reversible response + rollback"},["repairAttempts"]);},
 sandbox:()=>R("checks","SIMULATED sandbox response","No sandbox or production tool is actually executed."),
 checks(s,w){const blocked=w.sandbox==="blocked",failed=w.sandbox==="always fail"||(w.sandbox==="fail once"&&s.repairAttempts===1);return R(blocked?"repairBlocked":!failed?"prepared":s.repairAttempts<2?"plan":"repairExhausted","Sandbox checks: "+(blocked?"blocked":failed?"fail":"pass"),blocked?"Sandbox unavailable: return blocked.":!failed?"Hypothetical checks pass: return prepared, not production authorization.":s.repairAttempts<2?"Checks fail: LOCAL REVISE edge using remaining global repair budget.":"Checks fail at global repair cap: return exhausted.",{sandboxOutcome:blocked?"blocked":failed?"fail":"pass"},["repairAttempts"]);},
 prepared:()=>returned("prepared","prepared","POP remediation frame; parent must request human approval."),repairBlocked:()=>returned("blocked","repairBlocked","POP remediation frame: missing sandbox capability."),repairExhausted:()=>returned("exhausted","repairExhausted","POP remediation frame: global repair budget exhausted.")
 },
 verification:{
 criteria:()=>R("healthObserve","Select health criteria","Illustrative criteria: service availability, errors and saturation return to operator-defined acceptable ranges; no invented metric values.",{healthCriteria:"operator-defined availability / errors / saturation"}),
 healthObserve(s,w,f){f.samples++;return R("healthEvaluate","SIMULATED health sample","Sample "+f.samples+" of 3 for deployment "+s.deployments+"; no real telemetry is queried.",{verificationSamples:f.samples});},
 healthEvaluate(s,w,f){const bad=w.health==="never healthy"||(w.health==="first deployment unhealthy"&&s.deployments===1),unknown=w.health==="always unknown"||(w.health==="unknown once"&&f.samples===1);return R(bad?"unhealthy":!unknown?"healthy":f.samples<3?"healthObserve":"healthInconclusive","Evaluate health: "+(bad?"unhealthy":unknown?"unknown":"healthy"),bad?"Hypothetical failed health: RETURN unhealthy; parent rolls back.":!unknown?"Hypothetical health criteria met: RETURN healthy.":f.samples<3?"Unknown health: LOCAL SAMPLE-AGAIN edge; same deployment, remaining local budget.":"Unknown at local sample cap 3: RETURN inconclusive; parent rolls back.",{healthOutcome:bad?"unhealthy":unknown?"unknown":"healthy"},["verificationSamples","deployments"]);},
 healthy:()=>returned("healthy","healthy","POP verification frame; parent may close."),unhealthy:()=>returned("unhealthy","unhealthy","POP verification frame; parent must rollback and re-diagnose."),healthInconclusive:()=>returned("inconclusive","healthInconclusive","POP verification frame; sample exhaustion is not success.")
 }
};

return { MODEL, I, GR, ORDER, F, SC, H, world, defaults };
}
