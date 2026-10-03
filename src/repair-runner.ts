// Help > Repair IDE's checks, run one after another, each saying what it
// found and what it did: the order, the states and the words, apart from the
// window's dialog (repair.ts) so that they can be tested without one.

export type RepairState = 'waiting' | 'checking' | 'ok' | 'fixed' | 'problem' | 'skipped';
export type RepairOutcome = Exclude<RepairState, 'waiting' | 'checking'>;

// Words by their key in locales/, with {placeholders} filled in: the
// window's language on screen, English in Copy Details, as the debug report is.
export interface RepairMessage {
  key: string;
  values?: Record<string, string>;
}

// What someone can do about a problem, offered as a button beside it.
export interface RepairAction {
  key: string;
  run(): void;
}

export interface RepairResult {
  state: RepairOutcome;
  messages: RepairMessage[];
  actions?: RepairAction[];
}

export interface RepairCheck {
  id: string;
  // The key of its name: Background work, Code help, Git.
  title: string;
  // Given what the checks before it found, by id; it can say what it is doing meanwhile.
  run(found: ReadonlyMap<string, RepairResult>, doing: (message: RepairMessage) => void): Promise<RepairResult>;
}

export interface RepairStep {
  id: string;
  title: string;
  state: RepairState;
  messages: RepairMessage[];
  actions: RepairAction[];
}

// A message's words, the words for each key given.
export const say = (message: RepairMessage, word: (key: string) => string): string =>
  Object.entries(message.values ?? {}).reduce((text, [name, value]) => text.split(`{${name}}`).join(value), word(message.key));

// An error's message, as a check that failed says it.
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
  .replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');

// Runs the checks in order, telling each change of state as it happens. A
// check that throws is a problem saying why; the ones after it still run,
// unless the dialog was closed meanwhile: those stay waiting.
export const runRepair = async (
  checks: RepairCheck[], changed: (steps: RepairStep[]) => void, stopped: () => boolean = () => false,
): Promise<RepairStep[]> => {
  const steps = checks.map((check): RepairStep => ({ id: check.id, title: check.title, state: 'waiting', messages: [], actions: [] }));
  const found = new Map<string, RepairResult>();
  for (const [index, check] of checks.entries()) {
    if (stopped()) break;
    steps[index] = { ...steps[index], state: 'checking' };
    changed([...steps]);
    const doing = (message: RepairMessage): void => {
      if (steps[index].state !== 'checking') return;
      steps[index] = { ...steps[index], messages: [message] };
      changed([...steps]);
    };
    let result: RepairResult;
    try {
      result = await check.run(found, doing);
    } catch (error) {
      result = { state: 'problem', messages: [{ key: 'repairCheckFailed', values: { error: reason(error) } }] };
    }
    found.set(check.id, result);
    steps[index] = { ...steps[index], state: result.state, messages: result.messages, actions: result.actions ?? [] };
    changed([...steps]);
  }
  return steps;
};

// One line for the end: everything fine, fixed, or something left for the person.
export const repairSummary = (steps: RepairStep[]): RepairMessage => {
  const fixed = steps.some((step) => step.state === 'fixed');
  const problems = steps.some((step) => step.state === 'problem');
  if (problems) return { key: fixed ? 'repairFixedSome' : 'repairNeedsYou' };
  return { key: fixed ? 'repairAllFixed' : 'repairAllWell' };
};

// What Repair IDE found, for Copy Details: a section after the debug report,
// in English whatever the window's language, as the report is.
export const repairLog = (steps: RepairStep[], words: Record<string, string>, time: string, more: RepairMessage[] = []): string => {
  const word = (key: string): string => words[key] ?? key;
  return [
    '### Repair IDE',
    `time: ${time}`,
    ...steps.map((step) => `- ${word(step.title)}: ${step.state}${step.messages.length ? `. ${step.messages.map((message) => say(message, word)).join(' ')}` : ''}`),
    ...more.map((message) => `- ${say(message, word)}`),
    `summary: ${say(repairSummary(steps), word)}`,
    '',
  ].join('\n');
};
