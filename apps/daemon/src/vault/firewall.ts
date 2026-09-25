import { mustHelper } from '../metro-user/privilege.js';

export function applyFirewall(): void {
  mustHelper(['firewall-on']);
}

export function removeFirewall(): void {
  mustHelper(['firewall-off']);
}
