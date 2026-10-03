// eslint-disable-next-line import/no-unresolved
import * as monaco from 'monaco-editor/editor/editor.api';
import { tomlProblems, yamlProblems, type DataProblem } from './data-format';

// A mistake in a YAML or TOML file underlined where it is, as Monaco's JSON
// service does for JSON, a moment after typing stops.

const owner = 'glist-data';
const checks: Record<string, (text: string) => DataProblem[] | Promise<DataProblem[]>> = { yaml: yamlProblems, toml: tomlProblems };

const check = async (model: monaco.editor.ITextModel): Promise<void> => {
  const problems = checks[model.getLanguageId()];
  const version = model.getVersionId();
  const found = problems ? await problems(model.getValue()) : [];
  // Typed into meanwhile: the next check says where the mistakes are now.
  if (model.isDisposed() || model.getVersionId() !== version) return;
  monaco.editor.setModelMarkers(model, owner, found.map((problem) => {
    // A mistake said at one character underlines the word there.
    const word = problem.endLine === problem.line ? model.getWordAtPosition({ lineNumber: problem.line, column: problem.column }) : null;
    return {
      severity: monaco.MarkerSeverity.Error,
      message: problem.message,
      startLineNumber: problem.line,
      startColumn: problem.column,
      endLineNumber: problem.endLine,
      endColumn: Math.max(problem.endColumn, problem.column + 1, word?.endColumn ?? 0),
    };
  }));
};

export const checkDataFiles = (): void => {
  monaco.editor.onDidCreateModel((model) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = (): void => {
      if (!checks[model.getLanguageId()]) return;
      clearTimeout(timer);
      timer = setTimeout(() => { if (!model.isDisposed()) void check(model); }, 300);
    };
    void check(model);
    const changes = model.onDidChangeContent(later);
    const language = model.onDidChangeLanguage(() => { void check(model); });
    model.onWillDispose(() => {
      clearTimeout(timer);
      changes.dispose();
      language.dispose();
    });
  });
};
