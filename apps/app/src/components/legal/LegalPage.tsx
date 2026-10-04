import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { FONT_SIZE } from '@stage-labs/kit/tokens';
import { LegalLinks } from '../LegalLinks.js';
import { MarkdownBlock } from '../MarkdownBlock.js';
import { MetroLogo } from '../MetroLogo.js';
import { RouteLink } from '../RouteLink.js';
import { TextLink } from '../TextLink.js';
import { PageScroll } from '../PageScroll.js';
import { useDocumentTitle } from '../../lib/title.js';
import { LEGAL_PAGES } from './content.js';

type LegalKind = 'terms-of-use' | 'privacy-policy';

const BODY = FONT_SIZE['2xl'];
const LINE = Math.round(BODY * 1.6);

export function LegalPage({ kind }: { kind: LegalKind }): ReactNode {
  const palette = useKitPalette();
  const page = LEGAL_PAGES[kind];
  useDocumentTitle(page.title);
  return (
    <PageScroll>
      <Row justify="between" align="center" height={72} width="100%" maxWidth={MAX} padding={{ x: 24 }} style={CENTER}>
        <RouteLink to="#/" label="Metro home">
          <MetroLogo size={24} color={palette.link} />
        </RouteLink>
        <TextLink to="#/login" size="md">
          Log in
        </TextLink>
      </Row>
      <Col width="100%" maxWidth={760} padding={{ x: 24, top: 48, bottom: 48 }} gap={24} style={CENTER}>
        <MarkdownBlock text={page.text} size={BODY} lineHeight={LINE} />
      </Col>
      <Row justify="between" align="center" gap={16} width="100%" maxWidth={MAX} padding={{ x: 24, y: 24 }} style={CENTER}>
        <Text size="2xs" role="secondary">
          Stage Labs
        </Text>
        <Row gap={16}>
          <LegalLinks />
        </Row>
      </Row>
    </PageScroll>
  );
}

const CENTER = { alignSelf: 'center' } as const;
const MAX = 1200;
