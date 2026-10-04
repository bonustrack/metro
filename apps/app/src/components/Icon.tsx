import { type ReactElement } from 'react';
import { IconArrowDown } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconArrowDown';
import { IconArrowLeft } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconArrowLeft';
import { IconArrowRight } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconArrowRight';
import { IconArrowUp } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconArrowUp';
import { IconBookmark } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconBookmark';
import { IconBubble3 } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconBubble3';
import { IconBuildings } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconBuildings';
import { IconChart3 } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconChart3';
import { IconCheckmark1 } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconCheckmark1';
import { IconChevronGrabberVertical } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconChevronGrabberVertical';
import { IconChevronRight } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconChevronRight';
import { IconChip } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconChip';
import { IconCircleBanSign } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconCircleBanSign';
import { IconDotGrid1x3Horizontal } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconDotGrid1x3Horizontal';
import { IconExclamationCircle } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconExclamationCircle';
import { IconFileText } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconFileText';
import { IconFolder1 } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconFolder1';
import { IconGrid } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconGrid';
import { IconGroup1 } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconGroup1';
import { IconHand5Finger } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconHand5Finger';
import { IconHome } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconHome';
import { IconImac } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconImac';
import { IconKey2 } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconKey2';
import { IconMicrophone } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconMicrophone';
import { IconMoon } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconMoon';
import { IconPeople } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconPeople';
import { IconPlusLarge } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconPlusLarge';
import { IconServer } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconServer';
import { IconSettingsGear2 } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconSettingsGear2';
import { IconShieldCheck } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconShieldCheck';
import { IconSparklesThree } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconSparklesThree';
import { IconSquarePlus } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconSquarePlus';
import { IconSun } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconSun';
import { Glyph, type CentralIcon } from '@stage-labs/kit/react-native/glyph';

const ICONS = {
  arrowDown: IconArrowDown,
  arrowLeft: IconArrowLeft,
  arrowRight: IconArrowRight,
  arrowUp: IconArrowUp,
  ban: IconCircleBanSign,
  bookmark: IconBookmark,
  chartBar: IconChart3,
  chat: IconBubble3,
  check: IconCheckmark1,
  chevronRight: IconChevronRight,
  chip: IconChip,
  cog: IconSettingsGear2,
  desktop: IconImac,
  documentText: IconFileText,
  dotsHorizontal: IconDotGrid1x3Horizontal,
  exclamationCircle: IconExclamationCircle,
  folder: IconFolder1,
  hand: IconHand5Finger,
  home: IconHome,
  key: IconKey2,
  microphone: IconMicrophone,
  moon: IconMoon,
  officeBuilding: IconBuildings,
  plus: IconPlusLarge,
  selector: IconChevronGrabberVertical,
  server: IconServer,
  shieldCheck: IconShieldCheck,
  sparkles: IconSparklesThree,
  sun: IconSun,
  user: IconPeople,
  users: IconGroup1,
  viewGrid: IconGrid,
  viewGridAdd: IconSquarePlus,
};

export type IconName = keyof typeof ICONS;

interface IconProps {
  name: IconName;
  size: number;
  color: string;
}

export function iconOf(name: IconName): CentralIcon {
  return ICONS[name];
}

export function Icon({ name, size, color }: IconProps): ReactElement {
  return <Glyph icon={ICONS[name]} size={size} color={color} />;
}
