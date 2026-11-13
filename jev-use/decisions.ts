import { TypeSafeClient, choice, noul } from '@typesafe-ai/sdk';
import { jevClient } from './key-routing.js';

type Client = Pick<TypeSafeClient, 'systemOne'>;
const text = (value: unknown, name: string, max = 4000): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid ' + name);
  return value;
};
const workflows = {
  file_lookup: 'Locate files or folders by name, path, size or metadata through find_files.',
  content_search: 'Find text inside a known local folder through jev_search_content.',
  browser_task: 'Interact with a website through jev_browse.',
  desktop_task: 'Interact with a Windows application through jev_desktop.',
  direct_api: 'Use an already known API or deterministic procedure without UI exploration.',
};
const failures = {
  authentication: 'Evidence explicitly shows expired credentials, sign-in required or unauthorized access.',
  permission: 'Evidence shows a filesystem, operating-system or application permission denial.',
  unavailable: 'A required process, endpoint, application or dependency is missing or unreachable.',
  timeout: 'The operation exceeded its execution deadline.',
  stale_state: 'An observed control or page changed before execution, or the target is ambiguous.',
  invalid_input: 'The request arguments are malformed or unsupported.',
  unknown: 'The supplied evidence does not establish any offered cause.',
};
const recovery: Record<string, string> = {
  authentication: 'Request sign-in through the approved credential flow; do not retry credentials blindly.',
  permission: 'Inspect the specific denied resource and required access.',
  unavailable: 'Check harness status and the named dependency before retrying.',
  timeout: 'Read the final state before deciding whether a bounded retry is safe.',
  stale_state: 'Refresh the observation and rebuild valid controls before retrying.',
  invalid_input: 'Correct the arguments against the tool schema.',
  unknown: 'Gather the exact error and relevant state; escalate if still unexplained.',
};

/** One bounded judgment request. These tools never execute a selected workflow or retry. */
export async function decide(name: string, args: Record<string, unknown>, addUsage: (usage: unknown) => void,
  client: Client = jevClient({ timeout: 8000, retry: { maxRetries: 0 }, logLevel: 'off' })) {
  const started = Date.now();
  let state: Record<string, string>;
  let questions: Parameters<Client['systemOne']>[0]['questions'];
  let candidates: { id: string; text: string }[] = [];
  let criteria: Record<string, string> = {};
  if (name === 'jev_verify_result') {
    state = { request: text(args.request, 'request'), evidence: text(args.evidence, 'evidence', 16000) };
    questions = { satisfied: noul('Does the supplied evidence demonstrate that the request has been fulfilled?', {
      true: 'The evidence explicitly demonstrates the requested outcome.',
      false: 'The evidence contradicts the outcome or does not show that it occurred.',
    }) };
  } else if (name === 'jev_rank_results') {
    const query = text(args.query, 'query');
    if (!Array.isArray(args.candidates) || !args.candidates.length || args.candidates.length > 24) throw new Error('Supply 1 to 24 candidates');
    candidates = args.candidates.map((v: any) => ({ id: text(v?.id, 'candidate id', 80), text: text(v?.text, 'candidate text', 2000) }));
    if (new Set(candidates.map(c => c.id)).size !== candidates.length) throw new Error('Duplicate candidate id');
    criteria = Object.fromEntries(candidates.map((c, i) => ['result_' + i, c.text]));
    state = { request: query, candidates: JSON.stringify(criteria) };
    questions = { selected: choice('Which supplied result best answers the request?', criteria),
      fits: noul('Does any supplied result contain evidence relevant to the request?') };
  } else {
    const workflow = name === 'jev_select_workflow';
    if (!workflow && name !== 'jev_classify_failure') throw new Error('Unknown decision tool');
    state = workflow ? { request: text(args.request, 'request'), context: args.context === undefined ? '' : text(args.context, 'context', 8000) }
      : { operation: text(args.operation, 'operation'), evidence: text(args.evidence, 'evidence', 16000) };
    criteria = workflow ? workflows : failures;
    state.offered_categories = JSON.stringify(criteria);
    questions = { selected: choice(workflow ? 'Which workflow matches the requested operation?' : 'Which cause is directly supported by the failure evidence?', criteria),
      fits: noul(workflow ? 'Does the request match an offered workflow?' : 'Does the evidence establish a specific offered cause other than unknown?') };
  }
  const response = await client.systemOne({ state, questions });
  addUsage(response.usage);
  const probability = (answer: any) => {
    if (answer?.type !== 'noul' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new Error('Invalid Jev probability');
    return answer.noul as number;
  };
  const common = { status: 'done', decisions: 1, steps: 0, elapsed_ms: Date.now() - started, model: response.model };
  if (name === 'jev_verify_result') {
    const p = probability(response.answers.satisfied);
    return JSON.stringify({ ...common, verdict: p >= 0.7 ? 'satisfied' : p <= 0.3 ? 'not_satisfied' : 'uncertain', probability: p,
      limitation: 'Judgment of supplied evidence only; this tool does not independently observe the application.' });
  }
  const answer = response.answers.selected;
  if (answer.type !== 'choice' || !Object.hasOwn(criteria, answer.choice)) throw new Error('Invalid Jev selection');
  for (const [key, p] of Object.entries(answer.probabilities)) {
    if (!Object.hasOwn(criteria, key) || !Number.isFinite(p) || p < 0 || p > 1) throw new Error('Invalid Jev ranking');
  }
  const fit = probability(response.answers.fits);
  const accepted = fit >= 0.7;
  if (name === 'jev_rank_results') return JSON.stringify({ ...common, relevant: accepted, probability: fit,
    best_id: accepted ? candidates[Number(answer.choice.slice(7))].id : null,
    ranking: candidates.map((c, i) => ({ id: c.id, probability: answer.probabilities['result_' + i] ?? 0 })).sort((a, b) => b.probability - a.probability),
    limitation: 'Probabilities compare candidates for the single best result; they are not independent relevance scores.' });
  const selected = accepted ? answer.choice : null;
  return JSON.stringify({ ...common, selected, probability: fit, probabilities: answer.probabilities,
    ...(name === 'jev_classify_failure' ? { recovery: recovery[selected ?? 'unknown'], retry_executed: false } : { executed: false }) });
}
