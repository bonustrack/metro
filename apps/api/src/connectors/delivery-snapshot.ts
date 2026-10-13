import { DELIVERY_PLAINTEXT_MAX, type DeliveredConnector, type DeliverySnapshot } from '@metro-labs/http/connector-delivery';

const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

function unavailable(connector: DeliveredConnector): DeliveredConnector {
  return {
    id: connector.id, name: connector.name, url: new URL(connector.url).origin, auth: connector.auth,
    revision: connector.revision, state: 'unavailable', headers: {}, policy: { read: 'deny', write: 'deny' },
  };
}

export function boundedDeliverySnapshot(snapshot: DeliverySnapshot): DeliverySnapshot {
  let bytes = size(snapshot);
  if (bytes <= DELIVERY_PLAINTEXT_MAX) return snapshot;
  const connectors = [...snapshot.connectors];
  const reductions = connectors.map((connector, index) => {
    const replacement = unavailable(connector);
    return { index, replacement, saved: size(connector) - size(replacement) };
  }).sort((a, b) => b.saved - a.saved);
  for (const reduction of reductions) {
    if (reduction.saved <= 0) continue;
    connectors[reduction.index] = reduction.replacement;
    bytes -= reduction.saved;
    if (bytes <= DELIVERY_PLAINTEXT_MAX) return { ...snapshot, connectors };
  }
  throw new Error('Connector delivery is too large.');
}
