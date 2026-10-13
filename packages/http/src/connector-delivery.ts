import type { KeyObject } from 'node:crypto';
import { CONNECTOR_DELIVERY_MAX_BYTES, DELIVERY_PLAINTEXT_MAX, deliveryContextBytes, deliverySnapshotOf, type DeliveryContext, type DeliverySnapshot } from './connector-delivery-validation.js';
import { openTransfer, sealTransfer, type SealedTransfer } from './transfer-crypto.js';

export { CONNECTOR_DELIVERY_LEASE_MS, CONNECTOR_DELIVERY_MAX_BYTES, DELIVERY_PLAINTEXT_MAX, deliverySnapshotOf, type DeliveryContext, type DeliverySnapshot, type DeliveredConnector } from './connector-delivery-validation.js';
export { combineConnectorPolicies, connectorPolicyOf, effectiveConnectorPolicy, connectorPoliciesBlocked, validConnectorToolName, type ConnectorPolicy, type ConnectorPolicyLayers } from './connector-policy.js';
export type SealedDelivery = SealedTransfer;

export function sealConnectorDelivery(publicKey: string, context: DeliveryContext, snapshot: DeliverySnapshot): SealedDelivery {
  const sealed = sealTransfer(publicKey, deliveryContextBytes(context), Buffer.from(JSON.stringify(deliverySnapshotOf(snapshot))));
  if (Buffer.byteLength(JSON.stringify({ sealed })) > CONNECTOR_DELIVERY_MAX_BYTES) throw new Error('Connector delivery is too large.');
  return sealed;
}

export function openConnectorDelivery(privateKey: KeyObject, context: DeliveryContext, envelope: unknown): DeliverySnapshot {
  if (Buffer.byteLength(JSON.stringify({ sealed: envelope })) > CONNECTOR_DELIVERY_MAX_BYTES) throw new Error('Connector delivery is too large.');
  const plaintext = openTransfer(privateKey, deliveryContextBytes(context), envelope, DELIVERY_PLAINTEXT_MAX);
  return deliverySnapshotOf(JSON.parse(plaintext.toString('utf8')) as unknown);
}
