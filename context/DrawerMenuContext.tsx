import React, { createContext, useCallback, useContext, useMemo } from 'react';

type DrawerMenuContextValue = {
  openDrawer: () => void;
};

const DrawerMenuContext = createContext<DrawerMenuContextValue | null>(null);

export function DrawerMenuProvider({
  children,
  onOpen,
}: {
  children: React.ReactNode;
  onOpen: () => void;
}) {
  const openDrawer = useCallback(() => {
    onOpen();
  }, [onOpen]);

  const value = useMemo(() => ({ openDrawer }), [openDrawer]);

  return <DrawerMenuContext.Provider value={value}>{children}</DrawerMenuContext.Provider>;
}

export function useDrawerMenu(): DrawerMenuContextValue | null {
  return useContext(DrawerMenuContext);
}
