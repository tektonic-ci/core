import { Param } from '../lib/core/param';
import { Task } from '../lib/core/task';
import type { TaskStepSpec } from '../lib/core/task';
import type { StatusReporter } from '../lib/core/status-reporter';
import { injectedImageRef } from '../lib/core/injected-image';
import { EXIT_CODE_PATH, languageFor, Script, stepExitCodePath } from '../lib/script';

/**
 * A {@link StatusReporter} for core's own tests.
 *
 * The built-in reporter now lives in `@tektonic-ci/reporter-github`, which depends on
 * this package — core cannot import it back without a cycle, and should not want to: what
 * core's tests assert is the *contract* (a pending task per reporter group, a final step
 * that reads the exit-code file, a reconciler task carrying `$(tasks.X.status)` as a param),
 * not GitHub's wire format. Anything GitHub-specific belongs to that package's own tests.
 *
 * It is deliberately a straightforward implementation of the documented interface rather
 * than a mock: if implementing {@link StatusReporter} from the outside needs something core
 * does not export, writing this fixture is where that shows up.
 */
export class TestStatusReporter implements StatusReporter {
  private readonly image: string;
  /** Only changes the final step, so — as in the GitHub reporter — it is not in the group key. */
  readonly failOnError: boolean;
  readonly requiredParams: Param[];

  constructor(opts: { image?: string; failOnError?: boolean } = {}) {
    this.image = opts.image ?? injectedImageRef('nushell');
    this.failOnError = opts.failOnError ?? true;
    this.requiredParams = [
      new Param({ name: 'repo-full-name', type: 'string' }),
      new Param({ name: 'revision', type: 'string' }),
    ];
  }

  createPendingTask(contexts: string[], name = 'set-status-pending'): Task {
    return new Task({
      name,
      params: this.requiredParams,
      steps: contexts.map(context => ({
        name: `pending-${context.replace(/\//g, '-')}`,
        image: this.image,
        script: this.body(`pending ${context}`),
        onError: 'continue' as const,
      })),
    });
  }

  pendingGroupKey(): string {
    return JSON.stringify({ image: this.image });
  }

  finalStep(context: string, userStepNames: string[] = []): TaskStepSpec {
    const steps = userStepNames.map(s => `"${stepExitCodePath(s)}"`).join(', ');
    return {
      name: 'report-status',
      image: this.image,
      script: this.body(
        `let exit_code = (open --raw ${EXIT_CODE_PATH} | into int)\n` +
          `let step_codes = [${steps}]\n` +
          `log $"report ${context}: ($exit_code)"\n` +
          (this.failOnError ? 'exit $exit_code' : 'exit 0'),
      ),
    };
  }

  createStatusReconcilerTask(
    entries: { taskName: string; context: string }[],
    name = 'reconcile-status',
  ): Task {
    return new Task({
      name,
      params: [
        ...this.requiredParams,
        ...entries.map(
          e =>
            new Param({
              name: `status-${e.taskName}`,
              type: 'string',
              pipelineExpression: `$(tasks.${e.taskName}.status)`,
            }),
        ),
      ],
      steps: entries.map(e => ({
        name: `reconcile-${e.taskName}`,
        image: this.image,
        script: this.body(`log "reconcile ${e.context}: $(params.status-${e.taskName})"`),
        onError: 'continue' as const,
      })),
    });
  }

  private body(text: string): Script {
    return new Script(languageFor('nushell'), text);
  }
}

/**
 * A {@link TestStatusReporter} that also implements the optional
 * {@link StatusReporter.startStep}, reporting a context as running once its pod starts.
 */
export class StartingStatusReporter extends TestStatusReporter {
  startStep(context: string): TaskStepSpec {
    return {
      name: 'report-start',
      image: injectedImageRef('nushell'),
      script: new Script(languageFor('nushell'), `log "start ${context}"`),
    };
  }
}
