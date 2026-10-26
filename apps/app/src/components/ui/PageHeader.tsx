import { Fragment, type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Icon } from '../Icon.js';
import { RouteLink } from '../RouteLink.js';
import { ICON_SIZE, PAGE_TOP } from './sizes.js';
import { useIsNarrow } from '../../lib/media.js';
import { SHRINK } from '../../lib/style.js';

export interface Crumb {
  label: string;
  href?: string;
}

interface PageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  crumbs?: Crumb[];
  leading?: ReactNode;
  action?: ReactNode;
  tabs?: ReactNode;
}

const CRUMBS_HEIGHT = 56;
const TITLE_HEIGHT = 56;
const TABS_TOP = 24;

function CrumbLabel({ item, last }: { item: Crumb; last: boolean }): ReactNode {
  const text = (
    <Text size="xs" color={last ? undefined : 'secondary'} numberOfLines={1} style={SHRINK}>
      {item.label}
    </Text>
  );
  if (last || item.href === undefined) return text;
  return (
    <RouteLink to={item.href} label={item.label}>
      {text}
    </RouteLink>
  );
}

export function Crumbs({ items }: { items: Crumb[] }): ReactNode {
  const palette = useKitPalette();
  const back = [...items].reverse().find((item) => item.href !== undefined);
  return (
    <Row align="center" gap={8} minHeight={CRUMBS_HEIGHT} minWidth={0}>
      {back?.href === undefined ? null : (
        <RouteLink to={back.href} label={`Back to ${back.label}`}>
          <Icon name="chevronLeft" size={ICON_SIZE.md} color={palette.link} />
        </RouteLink>
      )}
      {items.map((item, index) => {
        const last = index === items.length - 1;
        return (
          <Fragment key={`${String(index)}:${item.label}`}>
            <CrumbLabel item={item} last={last} />
            {last ? null : <Icon name="chevronRight" size={ICON_SIZE.sm} color={palette.sub} />}
          </Fragment>
        );
      })}
    </Row>
  );
}

export function PageCrumbs({ items }: { items: Crumb[] }): ReactNode {
  const narrow = useIsNarrow();
  if (!narrow)
    return (
      <Column margin={{ top: -PAGE_TOP }}>
        <Crumbs items={items} />
      </Column>
    );
  const back = [...items].reverse().find((item) => item.href !== undefined);
  return back === undefined ? null : <Crumbs items={[back]} />;
}

function Subtitle({ subtitle }: { subtitle: ReactNode }): ReactNode {
  if (subtitle === undefined || subtitle === null) return null;
  if (typeof subtitle !== 'string') return subtitle;
  return (
    <Text size="xs" color="secondary" numberOfLines={2}>
      {subtitle}
    </Text>
  );
}

export function PageHeader({ title, subtitle, crumbs, leading, action, tabs }: PageHeaderProps): ReactNode {
  return (
    <Column>
      {crumbs === undefined || crumbs.length === 0 ? null : <PageCrumbs items={crumbs} />}
      <Row align="center" justify="spaceBetween" gap={16} minHeight={TITLE_HEIGHT}>
        <Row align="center" gap={16} weight={1} minWidth={0}>
          {leading}
          <Column gap={2} weight={1} minWidth={0}>
            <Text accessibilityRole="header" size="2xl" fontWeight="semibold" numberOfLines={2}>
              {title}
            </Text>
            <Subtitle subtitle={subtitle} />
          </Column>
        </Row>
        {action === undefined || action === null ? null : (
          <Row align="center" gap={12}>
            {action}
          </Row>
        )}
      </Row>
      {tabs === undefined || tabs === null ? null : <Column margin={{ top: TABS_TOP }}>{tabs}</Column>}
    </Column>
  );
}
