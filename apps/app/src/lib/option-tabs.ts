import type { TabsProps } from '@stage-labs/kit/react-native/tabs';

export interface TabOption<T extends string> {
  value: T;
  label: string;
}

export function optionTabs<T extends string>(options: readonly TabOption<T>[], value: string, onChange: (value: T) => void): Pick<TabsProps, 'tabs' | 'selectedIndex' | 'onChange'> {
  return {
    tabs: options.map((option) => ({ title: option.label })),
    selectedIndex: options.findIndex((option) => option.value === value),
    onChange: (index) => {
      const option = options[index];
      if (option !== undefined) onChange(option.value);
    },
  };
}
