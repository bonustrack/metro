import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Input } from './ui';
import { FieldLabel } from './FieldLabel';
import { GROW } from '../theme';
import { matchModels, type OpenRouterModel } from '../api/model';

const FIELD_WIDTH = 420;

interface PickerProps {
  label: string;
  value: string;
  placeholder: string;
  models: OpenRouterModel[] | undefined;
  loading: boolean;
  error: string | null;
  onOpen: () => void;
  onChange: (value: string) => void;
}

function Matches({ models, query, onPick }: { models: OpenRouterModel[]; query: string; onPick: (id: string) => void }): ReactNode {
  const found = matchModels(models, query);
  if (found.length === 0)
    return (
      <Text size="sm" role="secondary">
        No model matches that. Anything you type is used as it is.
      </Text>
    );
  return (
    <div className="model-matches">
      {found.map((model) => (
        <button
          key={model.id}
          type="button"
          className="model-match"
          onMouseDown={(e) => {
            e.preventDefault();
          }}
          onClick={() => {
            onPick(model.id);
          }}
        >
          <span className="model-match-id">{model.id}</span>
          {model.name === model.id ? null : <span className="model-match-name">{model.name}</span>}
        </button>
      ))}
    </div>
  );
}

export function ModelPicker({ label, value, placeholder, models, loading, error, onOpen, onChange }: PickerProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const shown = query ?? value;
  return (
    <Col gap={4} maxWidth={FIELD_WIDTH}>
      <FieldLabel>{label}</FieldLabel>
      <Input
        name={label}
        value={shown}
        placeholder={placeholder}
        dark={dark}
        onChangeText={(next) => {
          setQuery(next);
          setOpen(true);
          onChange(next);
        }}
        style={GROW}
        inputProps={{
          autoCapitalize: 'none',
          autoCorrect: false,
          spellCheck: false,
          onFocus: () => {
            setOpen(true);
            onOpen();
          },
          onBlur: () => {
            setOpen(false);
            setQuery(null);
          },
        }}
      />
      {!open ? null : (
        <Col gap={6}>
          {loading ? (
            <Text size="sm" role="secondary">
              Asking OpenRouter what it serves…
            </Text>
          ) : null}
          {error !== null ? (
            <Text size="sm" role="danger">
              {error}
            </Text>
          ) : null}
          {models === undefined ? null : (
            <Matches
              models={models}
              query={shown}
              onPick={(id) => {
                setQuery(null);
                setOpen(false);
                onChange(id);
              }}
            />
          )}
        </Col>
      )}
      <Row />
    </Col>
  );
}
