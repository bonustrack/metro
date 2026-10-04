import { createContext, useContext } from 'react';

export const Tabbed = createContext(false);

export const useTabbed = (): boolean => useContext(Tabbed);
