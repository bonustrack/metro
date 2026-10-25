import type { Lane } from './fallback.js';
import { GatewayError } from './forward.js';
import { helperSetup, primaryRoute, type ModelSetup, type Route } from './model-config.js';

export interface Chosen {
  lane: Lane;
  setup: ModelSetup;
  primary: Route;
}

const NO_ROUTE = "metro gateway: no model is set up for this agent yet: choose one on the organization's Gateway page";

const noRoute = (message: string): never => {
  throw new GatewayError(503, 'api_error', message);
};

const MAIN = 'metro';
export const WORKERS = 'metro-workers';
const NAMES = `Use the model "${MAIN}" (this agent's main models) or "${WORKERS}" (its worker models).`;

export const NAMED_MODELS = {
  data: [
    { id: MAIN, display_name: 'Main models', description: "This agent's main model order on Metro" },
    { id: WORKERS, display_name: 'Worker models', description: "This agent's worker model order on Metro" },
  ],
  has_more: false,
  first_id: MAIN,
  last_id: WORKERS,
};

export function namedChoice(requested: string, setup: ModelSetup): Chosen {
  if (requested !== MAIN && requested !== WORKERS) throw new GatewayError(400, 'invalid_request_error', NAMES);
  const helpers = requested === WORKERS ? helperSetup(setup) : null;
  const chain = helpers ?? setup;
  return { lane: helpers === null ? 'main' : 'helpers', setup: chain, primary: primaryRoute(chain) ?? noRoute(NO_ROUTE) };
}
