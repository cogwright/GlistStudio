import { t, type TranslationKey } from './localization';

// Settings > Agents: which coding agents the Agent tab offers. All are off
// until turned on; one that is not installed can be installed from here.

const storageKey = 'glist-studio-agents';

const loadEnabled = (): Set<GlistAgentId> => {
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]') as unknown;
    return new Set(Array.isArray(saved) ? saved.filter((id): id is GlistAgentId => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
};

const sourceText: Record<NonNullable<GlistAgentStatus['source']>, TranslationKey> = {
  studio: 'agentFromStudio',
  glist: 'agentFromGlist',
  system: 'agentFromSystem',
};

export interface AgentControls {
  options: HTMLElement;
  error: HTMLElement;
}

export class AgentSettings {
  private agents: GlistAgentStatus[] = [];
  private readonly enabled = loadEnabled();
  private installing: GlistAgentId | null = null;
  private progress = '';

  constructor(
    private readonly controls: AgentControls,
    // Told the agents the Agent tab offers, whenever that changes.
    private readonly onChange: (available: GlistAgentStatus[]) => void,
    private readonly log: (text: string, kind?: 'normal' | 'success' | 'error') => void,
  ) {
    window.glistAPI.onAgentInstall((text) => {
      this.log(text);
      const line = text.trim().split('\n').pop();
      if (line && this.installing) { this.progress = line; this.render(); }
    });
  }

  // Installed agents that are turned on.
  get available(): GlistAgentStatus[] {
    return this.agents.filter((agent) => agent.installed && this.enabled.has(agent.id));
  }

  async refresh(): Promise<void> {
    try {
      this.agents = await window.glistAPI.listAgents();
    } catch (error) {
      this.controls.error.textContent = error instanceof Error ? error.message : String(error);
    }
    this.render();
    this.onChange(this.available);
  }

  render(): void {
    this.controls.options.replaceChildren(...this.agents.map((agent) => this.row(agent)));
  }

  private setEnabled(agent: GlistAgentId, on: boolean): void {
    if (on) this.enabled.add(agent); else this.enabled.delete(agent);
    try { window.localStorage.setItem(storageKey, JSON.stringify([...this.enabled])); } catch { /* Storage may be unavailable. */ }
    this.onChange(this.available);
  }

  private row(agent: GlistAgentStatus): HTMLElement {
    const row = document.createElement('div');
    row.className = 'agent-option';
    const toggle = document.createElement('label');
    toggle.className = 'agent-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.checked = agent.installed && this.enabled.has(agent.id);
    input.disabled = !agent.installed;
    input.addEventListener('change', () => this.setEnabled(agent.id, input.checked));
    const name = document.createElement('span');
    name.className = 'agent-name';
    name.textContent = agent.name;
    toggle.append(input, name);

    const status = document.createElement('span');
    status.className = 'agent-status';
    if (this.installing === agent.id) status.textContent = this.progress || t('agentInstalling');
    else if (agent.installed && agent.source) status.textContent = t(sourceText[agent.source]);
    else status.textContent = t(agent.installable ? 'agentNotInstalled' : 'agentInstallYourself');
    if (agent.location) status.title = agent.location;
    row.append(toggle, status);

    if (!agent.installed && agent.installable) {
      const install = document.createElement('button');
      install.type = 'button';
      install.className = 'agent-install';
      install.textContent = t(this.installing === agent.id ? 'agentInstalling' : 'agentInstall');
      install.disabled = this.installing !== null;
      install.addEventListener('click', () => { void this.install(agent); });
      row.append(install);
    }
    return row;
  }

  private async install(agent: GlistAgentStatus): Promise<void> {
    this.installing = agent.id;
    this.progress = '';
    this.controls.error.textContent = '';
    this.render();
    this.log(`\n── ${agent.name} ────────────────────────────────\n`);
    try {
      const result = await window.glistAPI.installAgent(agent.id);
      this.log(`${result.message}\n`, result.success ? 'success' : 'error');
      if (!result.success) this.controls.error.textContent = result.message;
      // Installing it means wanting it: it is turned on.
      else this.setEnabled(agent.id, true);
    } catch (error) {
      this.controls.error.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      this.installing = null;
      await this.refresh();
    }
  }
}
