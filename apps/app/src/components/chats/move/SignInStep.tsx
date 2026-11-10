import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Text } from '@stage-labs/kit/react-native/text';
import { connectorHost } from '@metro-labs/client/api/connectors';
import type { MailStation, MoveStep } from '@metro-labs/client/api/mail-move';
import { TextLink } from '../../TextLink.js';
import { Actions } from '../../ui/Actions.js';
import { FocusIntro } from '../../ui/FocusFrame.js';
import { Group } from '../../ui/Group.js';
import { Item } from '../../ui/Item.js';
import { mailCompany } from '../../../lib/mail-move.js';
import type { MailMove } from '../../../lib/use-mail-move.js';
import { useToggle, type SignIn } from './use-move-actions.js';

type Need = Extract<MoveStep, { step: 'connector' }>;

interface StepProps {
  move: MailMove;
  need: Need;
  signIn: SignIn;
  station: MailStation;
  label: string;
  mailbox: string;
  onClose: () => void;
}

interface Words {
  text: string;
  danger?: string;
  main: string;
}

function wordsOf({ move, need, station, mailbox }: Pick<StepProps, 'move' | 'need' | 'station' | 'mailbox'>): Words {
  const company = mailCompany(station);
  const name = move.target?.connector.name ?? mailbox;
  const pick = `Pick ${mailbox} on ${company}'s page.`;
  if (need.need === 'wrong-mailbox')
    return { text: `Sign in again in a new tab. ${pick} If ${company} picks another account by itself, choose "Use another account" there.`, danger: `This connector is signed in to ${need.address}, not ${mailbox}. Nothing was moved.`, main: 'Sign in again' };
  if (need.need === 'confirm')
    return { text: `Metro cannot read which mailbox ${name} is signed in to. A browser that is already signed in to another account picks that one, so check it: the sign-in must be ${mailbox}.`, main: `Yes, it is ${mailbox}` };
  if (need.need === 'unreadable') return { text: `Metro could not check which mailbox ${name} is signed in to. Nothing was moved.`, main: 'Check again' };
  if (need.need === 'sign-in') return { text: `${name} is not signed in. ${company}'s sign-in opens in a new tab. ${pick} The channel keeps working until the last step.`, main: `Sign in with ${company}` };
  return { text: `Metro makes a connector for this mailbox, and ${company}'s sign-in opens in a new tab. ${pick} The channel keeps working until the last step.`, main: `Sign in with ${company}` };
}

function Waiting({ signIn, move }: { signIn: SignIn; move: MailMove }): ReactNode {
  if (!move.signingIn) return null;
  return (
    <Column gap={6}>
      <Text size="md" color="secondary">Finish the sign-in in the new tab. This page notices when it is done.</Text>
      {signIn.link === null ? null : <TextLink url={signIn.link}>Open the sign-in</TextLink>}
    </Column>
  );
}

function Connector({ move, label, mailbox }: Pick<StepProps, 'move' | 'label' | 'mailbox'>): ReactNode {
  const subtitle = move.target === null ? `A new ${label} connector of the organization, at ${connectorHost(move.server)}` : `${label} connector of the organization`;
  return (
    <Group label="Connector">
      <Item title={move.target?.connector.name ?? mailbox} subtitle={subtitle} chevron={false} />
    </Group>
  );
}

function Buttons({ move, need, signIn, onClose, main }: Pick<StepProps, 'move' | 'need' | 'signIn' | 'onClose'> & { main: string }): ReactNode {
  const recheck = useToggle(move.recheck, 'Could not check the mailbox.');
  const again = { label: 'Sign in again', onPress: signIn.start, disabled: signIn.busy };
  if (need.need === 'confirm') return <Actions error={signIn.error} cancel={again} main={{ label: main, onPress: move.confirm }} />;
  if (need.need === 'unreadable') return <Actions error={signIn.error ?? recheck.error} cancel={again} main={{ label: main, busy: recheck.busy, onPress: recheck.run }} />;
  return <Actions error={signIn.error} cancel={{ onPress: onClose, disabled: signIn.busy }} main={{ label: main, busy: signIn.busy, onPress: signIn.start }} />;
}

export function SignInStep(props: StepProps): ReactNode {
  const { move, signIn, mailbox } = props;
  const words = wordsOf(props);
  return (
    <>
      <FocusIntro title={`Sign in to ${mailbox}`} text={words.text} />
      {words.danger === undefined ? null : <Text size="md" color="danger">{words.danger}</Text>}
      <Connector {...props} />
      <Waiting signIn={signIn} move={move} />
      <Buttons {...props} main={words.main} />
    </>
  );
}
