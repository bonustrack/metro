import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui';
import { GROW } from '../theme';
import { Modal } from './Modal';
import { AddConnectors } from './AddConnectors';
import { addToCollection, createCollection } from '../api/collections';

interface NewCollectionProps {
  token: string;
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}

export function NewCollection({
  token,
  open,
  onClose,
  onCreated,
}: NewCollectionProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [name, setName] = useState('');
  const [step, setStep] = useState<'name' | 'connectors'>('name');
  const [error, setError] = useState<string | null>(null);

  const reset = (): void => {
    setName('');
    setStep('name');
    setError(null);
  };

  const close = (): void => {
    reset();
    onClose();
  };

  const create = async (connectorIds: string[]): Promise<void> => {
    const made = await createCollection(token, name.trim());
    for (const id of connectorIds) await addToCollection(token, made.id, id);
    reset();
    onCreated(made.id);
  };

  if (step === 'connectors')
    return (
      <AddConnectors
        token={token}
        title={`Add connectors to ${name.trim()}`}
        action="Create"
        initial={[]}
        open={open}
        onBack={() => {
          setStep('name');
        }}
        onClose={close}
        onSubmit={create}
      />
    );

  return (
    <Modal title="New collection" open={open} onClose={close}>
      <Col gap={14}>
        <Input
          name="collection-name"
          value={name}
          placeholder="work"
          dark={dark}
          onChangeText={setName}
          onSubmit={() => {
            if (name.trim() !== '') setStep('connectors');
          }}
          style={GROW}
        />
        {error === null ? null : (
          <Text size="sm" role="danger">
            {error}
          </Text>
        )}
        <Row justify="between" align="center" gap={12} wrap>
          <Button color="secondary" dark={dark} onPress={close} label="Cancel" />
          <Button
            color="primary"
            dark={dark}
            disabled={name.trim() === ''}
            onPress={() => {
              setError(null);
              setStep('connectors');
            }}
            label="Next"
          />
        </Row>
      </Col>
    </Modal>
  );
}
