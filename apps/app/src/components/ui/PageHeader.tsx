import { Fragment, type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Icon } from '../Icon.js';
import { RouteLink } from '../RouteLink.js';
import { SHRINK } from '../../lib/style.js';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  action?: ReactNode;
}

export function PageHeader({ title, subtitle, leading, action }: PageHeaderProps): ReactNode {
  return (
    <Row align="center" justify="between" gap={16} minHeight={56}>
      <Row align="center" gap={14} flex={1} minWidth={0}>
        {leading}
        <Col gap={2} flex={1} minWidth={0}>
          <Text accessibilityRole="header" size="2xl" weight="semibold" numberOfLines={2}>
            {title}
          </Text>
          {subtitle === undefined ? null : (
            <Text size="xs" role="secondary" numberOfLines={2}>
              {subtitle}
            </Text>
          )}
        </Col>
      </Row>
      {action}
    </Row>
  );
}

export interface Crumb {
  label: string;
  href?: string;
}

const BACK = 22;
const SEPARATOR = 14;

export function Crumbs({ items }: { items: Crumb[] }): ReactNode {
  const palette = useKitPalette();
  const back = [...items].reverse().find((item) => item.href !== undefined);
  return (
    <Row align="center" gap={6} minHeight={64} minWidth={0}>
      {back?.href === undefined ? null : (
        <RouteLink to={back.href} label={`Back to ${back.label}`}>
          <Icon name="chevronLeft" size={BACK} color={palette.link} />
        </RouteLink>
      )}
      {items.map((item, index) => {
        const last = index === items.length - 1;
        return (
          <Fragment key={`${String(index)}:${item.label}`}>
            <Text size="xs" role={last ? 'default' : 'secondary'} numberOfLines={1} style={SHRINK}>
              {item.label}
            </Text>
            {last ? null : <Icon name="chevronRight" size={SEPARATOR} color={palette.sub} />}
          </Fragment>
        );
      })}
    </Row>
  );
}
