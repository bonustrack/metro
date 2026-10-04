import { type ReactNode, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { Dialog } from '@stage-labs/kit/react-native/dialog';
import { createOrganization } from '@metro-labs/client/api/auth';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { enterOrganization } from '@metro-labs/client/auth/org-route';
import { activeAccount } from '@metro-labs/client/auth/account';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { currentSelection } from '@metro-labs/client/route';
import { selectionProject } from '@metro-labs/client/selection';
import { Icon } from './Icon.js';
import { NameModal } from './NameModal.js';
import { Face, statusWord } from './scope-parts.js';
import { SwitcherPanel } from './SwitcherPanel.js';
import { measure } from './Dropdown.js';
import { useServersQuery, useServerStatus, useOrganizationsQuery } from '../lib/queries.js';
import { useIsNarrow } from '../lib/media.js';
import { prefetchOrganization } from '../lib/organization.js';
import { useHover } from './ui/hover.js';
import { ABSOLUTE_FILL, SHRINK } from '../lib/style.js';

const AVATAR = 32;
const CHEVRON = 18;
const GAP = 8;
const EDGE = 8;
const PANEL_WIDTH = 560;

export interface Place {
  top: number;
  left: number;
  width: number;
}

const styles = StyleSheet.create({
  trigger: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8 },
  fill: { ...ABSOLUTE_FILL },
});

function AgentFace({ server, org }: { server: Server; org: string }): ReactNode {
  const { data } = useServerStatus(server.host);
  return (
    <>
      <Face server={server} size={AVATAR} />
      <Col flex={1} minWidth={0}>
        <Text size="md" weight="semibold" numberOfLines={1} style={SHRINK}>
          {serverLabel(server)}
        </Text>
        <Text size="2xs" role="secondary" numberOfLines={1}>
          {`${org} · ${statusWord(data?.state)}`}
        </Text>
      </Col>
    </>
  );
}

function OrgFace({ org }: { org: string }): ReactNode {
  return (
    <Col flex={1} minWidth={0}>
      <Text size="md" weight="semibold" numberOfLines={1} style={SHRINK}>
        {org}
      </Text>
      <Text size="2xs" role="secondary" numberOfLines={1}>
        All agents
      </Text>
    </Col>
  );
}

function Floating({ place, onClose, children }: { place: Place | null; onClose: () => void; children: ReactNode }): ReactNode {
  const palette = useKitPalette();
  const { height } = useWindowDimensions();
  const panel = { position: 'absolute', top: place?.top ?? 0, left: place?.left ?? 0, width: place?.width ?? PANEL_WIDTH, maxHeight: height - 80, borderRadius: 8, backgroundColor: palette.border, overflow: 'hidden' } as const;
  return (
    <Dialog open={place !== null} onClose={onClose} animationType="none" backdropColor="transparent" fullBleedPanel>
      <Pressable accessible={false} onPress={onClose} style={styles.fill}>
        <Pressable accessible={false} onPress={(e) => { e.stopPropagation(); }} style={panel}>
          <ScrollView>{children}</ScrollView>
        </Pressable>
      </Pressable>
    </Dialog>
  );
}

function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }): ReactNode {
  const palette = useKitPalette();
  return (
    <Dialog open={open} onClose={onClose} side="bottom" gestureRoot safeAreaBottom panelBackground={palette.border} panelRadius={12} panelMaxHeight="85%" scroll>
      {children}
    </Dialog>
  );
}

function usePlacement(): { place: Place | null; open: (view: View | null) => void; close: () => void } {
  const viewport = useWindowDimensions();
  const [place, setPlace] = useState<Place | null>(null);
  return {
    place,
    open: (view) => {
      measure(view)
        .then((box) => {
          if (box === null) return;
          const width = Math.min(PANEL_WIDTH, viewport.width - EDGE * 2);
          setPlace({ top: box.y + box.height + GAP, left: Math.min(box.x, viewport.width - width - EDGE), width });
        })
        .catch(() => undefined);
    },
    close: () => {
      setPlace(null);
    },
  };
}

export function OrganizationSwitcher({ onNavigate }: { onNavigate: () => void }): ReactNode {
  useOrganizationsQuery();
  const palette = useKitPalette();
  const client = useQueryClient();
  const narrow = useIsNarrow();
  const account = activeAccount();
  const { data } = useServersQuery();
  const here = currentServer();
  const [creating, setCreating] = useState(false);
  const [sheet, setSheet] = useState(false);
  const trigger = useRef<View>(null);
  const floating = usePlacement();
  const [hovered, hover] = useHover();
  const org = account?.organizationName ?? 'Organization';
  const inAgent = selectionProject(currentSelection()) !== null;
  const server = inAgent ? data?.find((s) => s.id === here?.id) : undefined;
  const close = (): void => {
    floating.close();
    setSheet(false);
  };
  const leave = (): void => {
    close();
    onNavigate();
  };
  const fill = { backgroundColor: hovered ? palette.inputBg : palette.border };
  const panel = <SwitcherPanel onClose={leave} onCreate={() => { close(); setCreating(true); }} stacked={narrow} />;
  return (
    <>
      <View ref={trigger} collapsable={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Switch organization or agent"
          {...hover}
          style={[styles.trigger, fill]}
          onPress={() => {
            if (narrow) setSheet(true);
            else floating.open(trigger.current);
          }}
        >
          {server === undefined ? <OrgFace org={org} /> : <AgentFace server={server} org={org} />}
          <Icon name="selector" size={CHEVRON} color={palette.sub} />
        </Pressable>
      </View>
      <Floating place={floating.place} onClose={close}>
        {panel}
      </Floating>
      <Sheet open={sheet} onClose={close}>
        {panel}
      </Sheet>
      <NameModal
        title="New organization"
        action="Create"
        placeholder="Acme"
        failure="Could not create the organization."
        open={creating}
        onClose={() => {
          setCreating(false);
        }}
        onSubmit={async (made) => {
          const created = await createOrganization(made);
          if (created.organization !== null) await enterOrganization(created.organization, prefetchOrganization(client));
          onNavigate();
          return made;
        }}
      />
    </>
  );
}

