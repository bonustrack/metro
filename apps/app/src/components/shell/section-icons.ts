import type { IconName } from '../Icon.js';
import type { ShellSectionId } from '../../lib/shell-sections.js';

export const SECTION_ICONS: Record<ShellSectionId, IconName> = {
  agents: 'robot',
  connectors: 'plug',
  models: 'processor',
  organization: 'officeBuilding',
};
