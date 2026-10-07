import { AutomationStore } from '@metro-labs/core/automation-store';
import { automationCommandFailure, automationRoot, runAutomationCommand } from './automation-command.js';

try {
  const result = await runAutomationCommand(process.argv.slice(2), { store: new AutomationStore(automationRoot()) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (err) {
  process.stderr.write(`metro task: ${automationCommandFailure(err)}\n`);
  process.exitCode = 1;
}
