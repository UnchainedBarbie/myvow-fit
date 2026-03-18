import React, { createContext, useState, useEffect, useContext, ReactNode } from 'react';
import { Appearance } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

// Define the themes
const LightTheme = {
  type: 'light',
  background: '#F5F0E8', // cream
  card: '#FFFFFF',
  text: '#2C2C2C',
  textSecondary: '#9A9A9A',
  /** Use for text on white/light card backgrounds so it stays visible in any scheme */
  textOnLightBackground: '#2C2C2C',
  textSecondaryOnLightBackground: '#5C5C5C',
  primary: '#7C9A7E', // sage green
  darkGreen: '#5C7A5E',
  lightGreen: '#DDE8DD',
  drawerBackground: '#C4D8C5',
  border: '#DDE8DD',
  buttonBackground: '#7C9A7E',
  buttonText: '#FFFFFF',
  // Home card colors now map into the new palette
  homeCardColor1: '#FFFFFF',
  homeCardColor2: '#FFFFFF',
  homeCardColor3: '#FFFFFF',
  homeButtonColor1: '#7C9A7E',
  homeButtonColor2: '#7C9A7E',
  homeButtonColor3: '#7C9A7E',
  homeButtonText1: '#FFFFFF',
  homeButtonText2: '#FFFFFF',
  homeButtonText3: '#FFFFFF',
  homeCardText1: '#2C2C2C',
  homeCardText2: '#2C2C2C',
  inactivetint: 'rgba(44, 44, 44, 0.2)',
  logborder: '#DDE8DD',
};

const DarkTheme = {
  type: 'dark',
  background: '#1C1C1E',
  card: '#2C2C2C',
  text: '#F5F0E8',
  textSecondary: '#9A9A9A',
  /** Use for text on white/light card backgrounds so it stays visible in any scheme */
  textOnLightBackground: '#2C2C2C',
  textSecondaryOnLightBackground: '#5C5C5C',
  primary: '#7C9A7E',
  darkGreen: '#5C7A5E',
  lightGreen: '#DDE8DD',
  drawerBackground: '#2A3B2B',
  border: 'rgba(221, 232, 221, 0.4)',
  buttonBackground: '#7C9A7E',
  buttonText: '#FFFFFF',
  homeCardColor1: '#2C2C2C',
  homeCardColor2: '#2C2C2C',
  homeCardColor3: '#2C2C2C',
  homeButtonColor1: '#7C9A7E',
  homeButtonColor2: '#7C9A7E',
  homeButtonColor3: '#7C9A7E',
  homeButtonText1: '#FFFFFF',
  homeButtonText2: '#FFFFFF',
  homeButtonText3: '#FFFFFF',
  homeCardText1: '#F5F0E8',
  homeCardText2: '#F5F0E8',
  inactivetint: 'rgba(245, 245, 245, 0.1)',
  logborder: 'rgba(245, 245, 245, 0.1)',
};

// Context for theme management
const ThemeContext = createContext({
  theme: LightTheme, // Default theme
  toggleTheme: () => {}, // Default placeholder function
});

type ThemeProviderProps = {
  children: ReactNode;
};

export const ThemeProvider = ({ children }: ThemeProviderProps) => {
  const [theme, setTheme] = useState(LightTheme);

  const themeFilePath = `${FileSystem.documentDirectory}theme.json`;

  useEffect(() => {
    const loadTheme = async () => {
      try {
        const storedTheme = await FileSystem.readAsStringAsync(themeFilePath);
        setTheme(storedTheme === 'dark' ? DarkTheme : LightTheme);
      } catch {
        const colorScheme = Appearance.getColorScheme();
        setTheme(colorScheme === 'dark' ? DarkTheme : LightTheme);
      }
    };
    loadTheme();
  }, []);

  const toggleTheme = async () => {
    const newTheme = theme === LightTheme ? DarkTheme : LightTheme;
    setTheme(newTheme);
    await FileSystem.writeAsStringAsync(
      themeFilePath,
      theme === LightTheme ? 'dark' : 'light',
    );
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => useContext(ThemeContext);

