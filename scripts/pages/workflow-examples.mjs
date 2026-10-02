import { createModel as conveyor } from '../../docs/articles/assets/workflow-models/conveyor-belt.mjs';
import { createModel as grilling } from '../../docs/articles/assets/workflow-models/collaborative-grilling.mjs';
import { createModel as magentic } from '../../docs/articles/assets/workflow-models/magentic-ui.mjs';
import { createModel as openSwe } from '../../docs/articles/assets/workflow-models/open-swe.mjs';
import { createModel as qaWolf } from '../../docs/articles/assets/workflow-models/qa-wolf-mapping-ai.mjs';
import { createModel as playwright } from '../../docs/articles/assets/workflow-models/playwright-test-agents.mjs';
import { createModel as meta } from '../../docs/articles/assets/workflow-models/meta-ach.mjs';
import { createModel as evalgen } from '../../docs/articles/assets/workflow-models/evalgen.mjs';
import { createModel as uxagent } from '../../docs/articles/assets/workflow-models/uxagent.mjs';
import { createModel as conversational } from '../../docs/articles/assets/workflow-models/conversational-ux-coanalysis.mjs';
import { createModel as checkout } from '../../docs/articles/assets/workflow-models/product-design-frontend.mjs';
import { createModel as incident } from '../../docs/articles/assets/workflow-models/incident-response.mjs';

export const WORKFLOW_EXAMPLES = [conveyor, grilling, magentic, openSwe, qaWolf, playwright, meta, evalgen, uxagent, conversational, checkout, incident].map(createModel => {
  const model = createModel();
  return { slug: model.MODEL.slug, file: `workflow-${model.MODEL.slug}.html`, asset: `assets/workflow-models/${model.MODEL.slug}.mjs`, metadata: model.MODEL };
});
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
export function renderWorkflowExample(template, example) {
  const m = example.metadata;
  const list = values => `<ul>${values.map(v => `<li>${esc(v)}</li>`).join('')}</ul>`;
  const reference = `<section class="panel box" id="sources"><h2>Sources and modeling boundaries</h2><p>${esc(m.evidenceStatus)}</p><p>Read: ${esc(m.researchDate)}. Version: ${esc(m.sourceVersion)}</p><h3>Source facts and provided context</h3>${list(m.documentedFeatures)}<h3>Graph abstraction</h3>${list(m.graphAbstraction)}<h3>Proposed extensions</h3>${list(m.proposedExtensions)}<ul>${m.sources.map(s => `<li><a href="${esc(s.url)}">${esc(s.title)}</a> — ${esc(s.note)}</li>`).join('')}</ul></section>`;
  return template
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(m.title)} · Simulator</title>`)
    .replace('<body>', `<body data-workflow="${esc(example.slug)}">`)
    .replace(/<header>[\s\S]*?<\/header>/, `<header><nav class="views" aria-label="Simulator view"><a href="simulator-overview.html">Original lifecycle overview</a><a href="simulator.html">Original detailed Simulator</a><a href="#sources">Sources and boundaries</a></nav><p class="lbl">Agent workflow examples · modeled workflow</p><h1>${esc(m.title)}</h1><p class="sub">${esc(m.lead)}</p><p>${esc(m.question)}</p><p>${esc(m.boundsText)}</p></header>`)
    .replace(/<div class="two">[\s\S]*?<footer>/, `${reference}<footer>`)
    .replace(/<footer>[\s\S]*?<\/footer>/, '<footer>Browser-local modeled execution, not a live agent, study, deployment or replication. Hypothetical inputs are editable; Back restores the full execution record, not the current inputs. Reset keeps current inputs; choosing a scenario restores its hypothetical initial conditions. <a href="simulator-overview.html">Original Simulator</a> · <a href="simulator.html">Detailed Simulator</a> · <a href="state-atlas.html">Diagrams generated from code tables</a>.</footer>');
}
